// SPDX-License-Identifier: MIT
// BNTB — BEP-20 bonus token for Bird and The Bees paid mints.
// Economics (SAKURA pattern, amounts user-confirmed 2026-11-12 —
// "bonus perkecil sesuaikan dengan jenis rarity"):
//   Total supply 1,000,000,000 BNTB (18 decimals), fixed at deploy —
//   NO further minting ever. Bonus pool 540,000,000 BNTB is held by this
//   token contract itself; the remaining 460,000,000 BNTB is minted to the
//   owner at deploy (treasury — owner-controlled, not part of the bonus
//   pool). Every PAID Bird and The Bees mint accrues BNTB for the
//   minter's wallet BY THE RARITY ACTUALLY DRAWN, recorded by the NFT
//   contract via accrue() (only the NFT contract — set by the owner with
//   setMinter() after the NFT deploys — can accrue):
//   Common Bluebird 1,000 / Uncommon Honeybee 2,000 / Rare Lovebirds
//   4,000 / Epic Golden Duo 8,000 / Legendary Royal Duo 16,000 /
//   Limited True Love 32,000. Free mints accrue 0.
//   Max 160,000 BNTB per wallet (5 paid x 32,000 worst case —
//   realistically far less, since only 1 Limited exists);
//   accrue() enforces both the per-wallet cap and the pool cap
//   (total accrued can never exceed 540,000,000).
//   Worst case the whole paid pool (1,444 mints) pays out at most
//   700x2,000 + 500x4,000 + 180x8,000 + 63x16,000 + 1x32,000
//   = 5,880,000 BNTB < 540,000,000 pool.
//   Claims are retroactive: claim() pays the caller's claimable balance;
//   claimFor(address) pays a beneficiary's claimable balance and can be
//   called by any wallet (e.g. an agent claiming for its user).
//   claimable(address) shows what is waiting. No staking, no tax, no
//   pausing, no blacklist — plain ERC-20 + accrual ledger.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title BNTB
contract BntbToken is ERC20, Ownable {
    uint256 public constant BONUS_POOL = 540_000_000 ether; // held by this contract
    uint256 public constant MAX_BONUS_PER_WALLET = 160_000 ether; // 5 paid x 32,000 worst case

    address public minter; // the Bird and The Bees NFT contract; set by owner after NFT deploy
    uint256 public totalAccrued; // sum of all accrue() amounts; never exceeds BONUS_POOL

    mapping(address => uint256) public accrued; // lifetime bonus earned
    mapping(address => uint256) public claimed; // lifetime bonus claimed

    event Accrued(address indexed wallet, uint256 amount, uint256 totalAccruedForWallet);
    event Claimed(address indexed wallet, uint256 amount);
    event MinterSet(address indexed minter);

    error NotMinter();
    error NothingToClaim();
    error OverPoolCap();
    error OverWalletCap();

    constructor(address owner_) ERC20("BNTB", "BNTB") Ownable(owner_) {
        // Pool stays in this contract for claims; remainder goes to the owner.
        _mint(address(this), BONUS_POOL);
        _mint(owner_, 460_000_000 ether);
    }

    /// @notice Claimable BNTB for a wallet (accrued minus already claimed).
    function claimable(address wallet) public view returns (uint256) {
        return accrued[wallet] - claimed[wallet];
    }

    /// @notice Record a bonus for a wallet. Only the NFT contract can call this.
    function accrue(address wallet, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (totalAccrued + amount > BONUS_POOL) revert OverPoolCap();
        if (accrued[wallet] + amount > MAX_BONUS_PER_WALLET) revert OverWalletCap();
        accrued[wallet] += amount;
        totalAccrued += amount;
        emit Accrued(wallet, amount, accrued[wallet]);
    }

    /// @notice Claim your own waiting BNTB.
    function claim() external {
        _claim(msg.sender);
    }

    /// @notice Claim a beneficiary's waiting BNTB to that beneficiary. Callable by anyone.
    function claimFor(address beneficiary) external {
        _claim(beneficiary);
    }

    function _claim(address wallet) internal {
        uint256 amount = claimable(wallet);
        if (amount == 0) revert NothingToClaim();
        claimed[wallet] += amount;
        _transfer(address(this), wallet, amount);
        emit Claimed(wallet, amount);
    }

    /// @notice Point accrual at the Bird and The Bees NFT contract (called once, by owner, after NFT deploy).
    function setMinter(address minter_) external onlyOwner {
        minter = minter_;
        emit MinterSet(minter_);
    }
}
