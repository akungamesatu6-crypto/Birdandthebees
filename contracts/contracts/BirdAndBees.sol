// SPDX-License-Identifier: MIT
// Bird and The Bees — BSC BEP-721, a blue bird + a yellow bee, from first
// hello to True Love.
// Spec (user-confirmed 2026-11-12, main chat):
//   Supply 4,444, RANDOM token ids (swap-and-pop pools, NOT VRF).
//   Rarity by token id (in metadata — 6 artworks):
//   Common Bluebird 1-3000 (3,000)
//   Uncommon Honeybee 3001-3700 (700)
//   Rare Lovebirds 3701-4200 (500)
//   Epic Golden Duo 4201-4380 (180)
//   Legendary Royal Duo 4381-4443 (63)
//   Limited True Love 4444 (1).
//   TWO LANES (SAKURA model + new rarity rules):
//   - FREE lane: mintFree(), Agent ID ONLY (msg.sender == tx.origin +
//     SPACE ID Agent ID registry balance > 0). 1 free per wallet, price 0,
//     accrues 0 BNTB. Free mints draw ONLY from the Common pool
//     (ids 1-3000); the free pool is capped at 3,000 total free mints.
//   - PAID lane: mintPaid(qty), PUBLIC — any wallet, no agent gate.
//     NEW vs SAKURA: single paid mints (qty 1-4) draw from the COMBINED
//     paid + top pools (ids 3001-4444), so a single paid mint CAN reach
//     Legendary and Limited — chance is very small (natural deck odds:
//     Legendary 63/1444 ≈ 4.4%, Limited 1/1444 ≈ 0.07% at launch).
//     A 5-at-once purchase (qty == 5) costs 0.0024 BNB total (small
//     discount vs 5 x 0.0005 = 0.0025) and draws the same combined pool
//     "lucky redirect" per draw: a draw that would land in the paid pool
//     has a 5% chance to redirect to the top pool instead — a slight
//     (not guaranteed) lift to the top-3 odds. Max 5 paid per wallet.
//     Each PAID mint accrues BNTB BY RARITY (user: "bonus perkecil
//     sesuaikan dengan jenis rarity"): Common 1,000 / Uncommon 2,000 /
//     Rare 4,000 / Epic 8,000 / Legendary 16,000 / Limited 32,000.
//     Free mints accrue nothing. Max 160,000 BNTB per wallet
//     (5 paid x 32,000 worst case). The token contract is immutable,
//     set in the constructor (the token deploys first, so its address
//     is known).
//   Total cap 6 per wallet (1 free + 5 paid). Free and paid can be
//   claimed in any order: an agent may mint paid first and claim the
//   free later, and vice versa.
//   Mint money: forwarded to the owner (project wallet) in the same tx;
//   the contract does not hold mint revenue.
//   Royalty 5% (ERC-2981). Owner can ONLY: open/close mint, set base URI,
//   withdraw stuck funds. Prices, supply and limits are immutable after
//   deploy.
//   baseURI: https://bntb.fun/metadata/ (custom domain, user-confirmed
//   2026-11-12; DNS currently placeholder — point to host at deploy)
//   Language: Japanese primary + English second option (page only, draft).
//   Official X: TBD.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentID {
    function balanceOf(address) external view returns (uint256);
}

interface IBntbToken {
    function accrue(address wallet, uint256 amount) external;
}

/// @title Bird and The Bees
contract BirdAndBees is ERC721, ERC2981, Ownable, ReentrancyGuard {
    IAgentID public immutable AGENT_ID;
    IBntbToken public immutable TOKEN;

    uint256 public constant MAX_SUPPLY = 4444;
    uint256 public constant MAX_PER_WALLET = 6;
    uint256 public constant FREE_PER_WALLET = 1;
    uint256 public constant MAX_PAID_PER_WALLET = 5;
    uint256 public constant FREE_CAP = 3000;
    uint256 public constant PRICE_PAID_SINGLE = 0.0005 ether; // 0.0005 BNB per paid mint
    uint256 public constant PRICE_PACK_5 = 0.0024 ether; // 0.0024 BNB for 5 at once (small discount vs 5 x 0.0005 = 0.0025)

    // Rarity bonus per paid mint, by tier (BNTB).
    uint256 public constant BONUS_COMMON = 1_000 ether;
    uint256 public constant BONUS_UNCOMMON = 2_000 ether;
    uint256 public constant BONUS_RARE = 4_000 ether;
    uint256 public constant BONUS_EPIC = 8_000 ether;
    uint256 public constant BONUS_LEGENDARY = 16_000 ether;
    uint256 public constant BONUS_LIMITED = 32_000 ether;

    // Draw pools (swap-and-pop, lazy identity mapping — Hakuna pattern).
    // Free pool: ids 1-3000 (Common). Paid pool: ids 3001-4380
    // (Uncommon/Rare/Epic). Top pool: ids 4381-4444 (Legendary/Limited).
    uint256 public constant FREE_POOL_SIZE = 3000;
    uint256 public constant PAID_POOL_SIZE = 1380;
    uint256 public constant TOP_POOL_SIZE = 64;

    uint256 public totalMinted;
    uint256 public paidMinted;
    uint256 public freeMinted;
    bool public mintOpen;
    string private _base;

    uint256 private _freeRemaining = FREE_POOL_SIZE;
    uint256 private _paidRemaining = PAID_POOL_SIZE;
    uint256 private _topRemaining = TOP_POOL_SIZE;
    mapping(uint256 => uint256) private _freeAtIndex; // 0 = identity (id = index + 1)
    mapping(uint256 => uint256) private _paidAtIndex; // 0 = identity (id = 3001 + index)
    mapping(uint256 => uint256) private _topAtIndex; // 0 = identity (id = 4381 + index)

    mapping(address => uint256) public mintedOf;
    mapping(address => uint256) public freeMintedOf;
    mapping(address => uint256) public paidMintedOf;

    event Minted(address indexed minter, uint256 indexed id, bool paid, uint256 priceWei);

    error NotAgent();
    error MintClosed();
    error SoldOut();
    error OverLimit();
    error Underpaid(uint256 required);
    error FreeClaimed();
    error FreeCapReached();

    constructor(
        string memory baseURI_,
        address owner_,
        address agentId_,
        address token_
    ) ERC721("Bird and The Bees", "BNTB") Ownable(owner_) {
        _base = baseURI_;
        AGENT_ID = IAgentID(agentId_);
        TOKEN = IBntbToken(token_);
        mintOpen = false; // mint starts CLOSED until owner opens it
        _setDefaultRoyalty(owner_, 500); // 5%
    }

    modifier onlyAgent() {
        if (msg.sender != tx.origin || AGENT_ID.balanceOf(msg.sender) == 0) revert NotAgent();
        if (!mintOpen) revert MintClosed();
        _;
    }

    modifier whenOpen() {
        if (!mintOpen) revert MintClosed();
        _;
    }

    /// @notice BNTB bonus for a token id, by rarity tier.
    function bonusForId(uint256 id) public pure returns (uint256) {
        if (id <= 3000) return BONUS_COMMON; // Bluebird
        if (id <= 3700) return BONUS_UNCOMMON; // Honeybee
        if (id <= 4200) return BONUS_RARE; // Lovebirds
        if (id <= 4380) return BONUS_EPIC; // Golden Duo
        if (id <= 4443) return BONUS_LEGENDARY; // Royal Duo
        return BONUS_LIMITED; // True Love (4444)
    }

    /// @notice Rarity tier name for a token id (for the page/metadata).
    function rarityOf(uint256 id) public pure returns (string memory) {
        if (id <= 3000) return "Common";
        if (id <= 3700) return "Uncommon";
        if (id <= 4200) return "Rare";
        if (id <= 4380) return "Epic";
        if (id <= 4443) return "Legendary";
        return "Limited";
    }

    /// @notice Tier character name for a token id.
    function tierNameOf(uint256 id) public pure returns (string memory) {
        if (id <= 3000) return "Bluebird";
        if (id <= 3700) return "Honeybee";
        if (id <= 4200) return "Lovebirds";
        if (id <= 4380) return "Golden Duo";
        if (id <= 4443) return "Royal Duo";
        return "True Love";
    }

    /// @notice BNB cost for `qty` further PAID mints by `wallet`.
    /// Singles: qty x 0.001 BNB. A 5-at-once purchase: 0.004 BNB flat.
    function quotePaidFor(address wallet, uint256 qty) public view returns (uint256) {
        if (qty == 0 || paidMintedOf[wallet] + qty > MAX_PAID_PER_WALLET) revert OverLimit();
        if (_paidRemaining + _topRemaining < qty) revert SoldOut();
        if (qty == 5) return PRICE_PACK_5;
        return PRICE_PAID_SINGLE * qty;
    }

    /// @notice Live BNB cost of the cheapest paid mint (one single = 0.001 BNB).
    function priceWei() public pure returns (uint256) {
        return PRICE_PAID_SINGLE;
    }

    /// @notice Flat BNB cost of a 5-at-once purchase (0.004 BNB).
    function pricePack5() public pure returns (uint256) {
        return PRICE_PACK_5;
    }

    function totalSupply() external view returns (uint256) {
        return totalMinted;
    }

    function exists(uint256 id) external view returns (bool) {
        return _ownerOf(id) != address(0);
    }

    function freeRemaining() external view returns (uint256) {
        return _freeRemaining;
    }

    function paidRemaining() external view returns (uint256) {
        return _paidRemaining;
    }

    function topRemaining() external view returns (uint256) {
        return _topRemaining;
    }

    /// @notice Draw one token id from a pool (swap-and-pop, Hakuna pattern).
    /// `pool` holds index -> token id overrides; 0 means identity (base + index).
    function _drawFrom(
        mapping(uint256 => uint256) storage pool,
        uint256 remaining,
        uint256 index,
        uint256 base
    ) internal returns (uint256) {
        uint256 tokenId = pool[index] == 0 ? base + index : pool[index];
        uint256 lastIndex = remaining - 1;
        uint256 lastTokenId = pool[lastIndex] == 0 ? base + lastIndex : pool[lastIndex];
        pool[index] = lastTokenId;
        return tokenId;
    }

    /// @notice Draw one id from the combined paid pools (paid 3001-4380 +
    /// top 4381-4444), weighted by what remains in each. `boost` (5-pack
    /// only): a draw that would land in the paid pool has a 1-in-20
    /// chance to redirect to the top pool instead — a slight lift to the
    /// top-3 odds, never a guarantee.
    function _drawPaidPack(uint256 seed, bool boost) internal returns (uint256) {
        uint256 total = _paidRemaining + _topRemaining;
        uint256 r = seed % total;
        bool useTop = r >= _paidRemaining;
        if (!useTop && boost && _topRemaining > 0) {
            uint256 roll = uint256(keccak256(abi.encodePacked(seed, "BNTB-BOOST"))) % 20;
            if (roll == 0) useTop = true;
        }
        uint256 id;
        if (useTop) {
            uint256 idx = r >= _paidRemaining
                ? r - _paidRemaining
                : uint256(keccak256(abi.encodePacked(seed, "BNTB-TOP"))) % _topRemaining;
            id = _drawFrom(_topAtIndex, _topRemaining, idx, 4381);
            _topRemaining -= 1;
        } else {
            id = _drawFrom(_paidAtIndex, _paidRemaining, r, 3001);
            _paidRemaining -= 1;
        }
        return id;
    }

    /// @notice FREE lane: mint the wallet's one free bird/bee (Bluebird).
    /// Agent ID ONLY. No payment, accrues 0 BNTB.
    function mintFree() external nonReentrant onlyAgent {
        if (freeMintedOf[msg.sender] >= FREE_PER_WALLET) revert FreeClaimed();
        if (freeMinted >= FREE_CAP) revert FreeCapReached();
        if (totalMinted + 1 > MAX_SUPPLY) revert SoldOut();
        uint256 seed = uint256(
            keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, msg.sender, totalMinted, uint256(0)))
        );
        uint256 id = _drawFrom(_freeAtIndex, _freeRemaining, seed % _freeRemaining, 1);
        _freeRemaining -= 1;
        totalMinted++;
        freeMinted++;
        freeMintedOf[msg.sender]++;
        mintedOf[msg.sender]++;
        _safeMint(msg.sender, id);
        emit Minted(msg.sender, id, false, 0);
    }

    /// @notice PAID lane: mint `qty` birds/bees. PUBLIC — any wallet.
    /// qty 1-4: 0.0005 BNB each, draws from ids 3001-4444 (Uncommon
    /// through Limited) — a single paid mint CAN reach Legendary and
    /// Limited, chance very small (natural deck odds).
    /// qty 5: 0.0024 BNB total, draws the same combined pool with the
    /// 1-in-20 lucky redirect — a slight lift to the top-3 odds.
    /// Each paid mint accrues BNTB by the rarity actually drawn
    /// (Common 1,000 / Uncommon 2,000 / Rare 4,000 / Epic 8,000 /
    /// Legendary 16,000 / Limited 32,000).
    function mintPaid(uint256 qty) external payable nonReentrant whenOpen {
        if (qty == 0 || qty > MAX_PAID_PER_WALLET) revert OverLimit();
        if (paidMintedOf[msg.sender] + qty > MAX_PAID_PER_WALLET) revert OverLimit();
        if (mintedOf[msg.sender] + qty > MAX_PER_WALLET) revert OverLimit();
        if (totalMinted + qty > MAX_SUPPLY) revert SoldOut();
        bool pack = qty == 5;
        if (_paidRemaining + _topRemaining < qty) revert SoldOut();
        uint256 cost = quotePaidFor(msg.sender, qty);
        if (msg.value < cost) revert Underpaid(cost);
        uint256 priceEach = pack ? PRICE_PACK_5 / 5 : PRICE_PAID_SINGLE;

        uint256 totalBonus;
        for (uint256 i; i < qty; i++) {
            uint256 seed = uint256(
                keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, msg.sender, totalMinted, i))
            );
            uint256 id = _drawPaidPack(seed, pack);
            totalMinted++;
            paidMinted++;
            totalBonus += bonusForId(id);
            _safeMint(msg.sender, id);
            emit Minted(msg.sender, id, true, priceEach);
        }
        paidMintedOf[msg.sender] += qty;
        mintedOf[msg.sender] += qty;

        TOKEN.accrue(msg.sender, totalBonus);

        // Mint money goes straight to the project wallet.
        if (cost > 0) {
            (bool ok, ) = owner().call{value: cost}("");
            require(ok, "forward");
        }
        if (msg.value > cost) {
            (bool ok, ) = msg.sender.call{value: msg.value - cost}("");
            require(ok, "refund");
        }
    }

    /// @notice tokenURI returns the metadata file immediately, from mint time.
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return string.concat(_base, Strings.toString(id));
    }

    // ── owner: only these switches exist ──
    function setMintOpen(bool v) external onlyOwner {
        mintOpen = v;
    }

    function setBaseURI(string calldata b) external onlyOwner {
        _base = b;
    }

    function withdraw() external onlyOwner nonReentrant {
        (bool ok, ) = owner().call{value: address(this).balance}("");
        require(ok, "withdraw");
    }

    function supportsInterface(bytes4 i) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(i);
    }
}
