// Bird and The Bees NFT + BNTB token tests — RANDOM two-lane model.
// FREE lane: mintFree(), Agent ID ONLY, 1 per wallet, accrues 0 BNTB,
// draws ONLY from Common ids 1-3000 (Bluebird, free cap 3,000 total).
// PAID lane: mintPaid(qty), PUBLIC (no agent gate). Singles (qty 1-4)
// AND 5-pack (qty == 5) both draw from the COMBINED paid + top pools
// (ids 3001-4444, Uncommon through Limited) — a single paid mint CAN
// reach Legendary (4381-4443) and Limited (4444), chance very small
// (natural deck odds). The 5-pack adds a 1-in-20 lucky redirect per
// draw toward the top pool — a slight lift to the top-3 odds.
// Prices: singles 0.0005 BNB each, 5-pack 0.0024 BNB total (small discount vs 5 x 0.0005 = 0.0025).
// Max 5 paid per wallet, 6 total per wallet.
// Bonus BNTB per PAID mint BY RARITY: Common 1,000 / Uncommon 2,000 /
// Rare 4,000 / Epic 8,000 / Legendary 16,000 / Limited 32,000.
// Revenue forwarded to owner.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const BASE_URI = "https://bntb.fun/metadata/";
const OWNER_ADDR = "0x36F3D56eAD5D1D6C2434F94DeFcEF732C5C3CbD2"; // project wallet (mainnet)
const PRICE_SINGLE = ethers.parseEther("0.0005");
const PRICE_PACK_5 = ethers.parseEther("0.0024");

// Mirror of BirdAndBees.bonusForId — expected BNTB for a token id.
function bonusForId(id) {
  if (id <= 3000) return ethers.parseEther("1000");
  if (id <= 3700) return ethers.parseEther("2000");
  if (id <= 4200) return ethers.parseEther("4000");
  if (id <= 4380) return ethers.parseEther("8000");
  if (id <= 4443) return ethers.parseEther("16000");
  return ethers.parseEther("32000");
}

// Extract Minted event ids from a mint receipt (ids are random).
async function mintedIds(nft, tx) {
  const receipt = await tx.wait();
  const ids = [];
  for (const log of receipt.logs) {
    try {
      const parsed = nft.interface.parseLog(log);
      if (parsed && parsed.name === "Minted") ids.push(Number(parsed.args.id));
    } catch {}
  }
  return ids;
}

describe("Bird and The Bees NFT + BNTB token (random two-lane)", function () {
  let owner, agent1, agent2, stranger, buyer;
  let registry, token, nft;
  let freeId;
  let strangerBonus = 0n;
  let agent1PackBonus = 0n;

  before(async function () {
    [owner, agent1, agent2, stranger, buyer] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockAgentID");
    registry = await Mock.deploy();
    await registry.mint(agent1.address);
    await registry.mint(agent2.address);
    // stranger + buyer hold NO Agent ID — they are public wallets.

    const Token = await ethers.getContractFactory("BntbToken");
    token = await Token.deploy(owner.address);

    const NFT = await ethers.getContractFactory("BirdAndBees");
    nft = await NFT.deploy(BASE_URI, owner.address, await registry.getAddress(), await token.getAddress());
    await token.connect(owner).setMinter(await nft.getAddress());
    await nft.connect(owner).setMintOpen(true);
  });

  it("constructor: name/symbol/supply/limits/prices/pools, mint starts CLOSED", async function () {
    expect(await nft.name()).to.equal("Bird and The Bees");
    expect(await nft.symbol()).to.equal("BNTB");
    expect(await nft.MAX_SUPPLY()).to.equal(4444);
    expect(await nft.MAX_PER_WALLET()).to.equal(6);
    expect(await nft.FREE_PER_WALLET()).to.equal(1);
    expect(await nft.MAX_PAID_PER_WALLET()).to.equal(5);
    expect(await nft.FREE_CAP()).to.equal(3000);
    expect(await nft.PRICE_PAID_SINGLE()).to.equal(PRICE_SINGLE);
    expect(await nft.PRICE_PACK_5()).to.equal(PRICE_PACK_5);
    expect(await nft.BONUS_COMMON()).to.equal(ethers.parseEther("1000"));
    expect(await nft.BONUS_UNCOMMON()).to.equal(ethers.parseEther("2000"));
    expect(await nft.BONUS_RARE()).to.equal(ethers.parseEther("4000"));
    expect(await nft.BONUS_EPIC()).to.equal(ethers.parseEther("8000"));
    expect(await nft.BONUS_LEGENDARY()).to.equal(ethers.parseEther("16000"));
    expect(await nft.BONUS_LIMITED()).to.equal(ethers.parseEther("32000"));
    expect(await nft.totalSupply()).to.equal(0);
    expect(await nft.owner()).to.equal(owner.address);
    expect(await nft.freeRemaining()).to.equal(3000);
    expect(await nft.paidRemaining()).to.equal(1380);
    expect(await nft.topRemaining()).to.equal(64);

    const NFT = await ethers.getContractFactory("BirdAndBees");
    const fresh = await NFT.deploy(BASE_URI, owner.address, await registry.getAddress(), await token.getAddress());
    expect(await fresh.mintOpen()).to.equal(false);
  });

  it("token: name/symbol, 1B total, 540M pool in contract, 460M treasury to owner", async function () {
    expect(await token.name()).to.equal("BNTB");
    expect(await token.symbol()).to.equal("BNTB");
    expect(await token.totalSupply()).to.equal(ethers.parseEther("1000000000"));
    expect(await token.balanceOf(await token.getAddress())).to.equal(ethers.parseEther("540000000"));
    expect(await token.balanceOf(owner.address)).to.equal(ethers.parseEther("460000000"));
    expect(await token.minter()).to.equal(await nft.getAddress());
    expect(await token.BONUS_POOL()).to.equal(ethers.parseEther("540000000"));
    expect(await token.MAX_BONUS_PER_WALLET()).to.equal(ethers.parseEther("160000"));
  });

  it("bonusForId/rarityOf/tierNameOf: tier boundaries", async function () {
    expect(await nft.bonusForId(1)).to.equal(ethers.parseEther("1000"));
    expect(await nft.bonusForId(3000)).to.equal(ethers.parseEther("1000"));
    expect(await nft.bonusForId(3001)).to.equal(ethers.parseEther("2000"));
    expect(await nft.bonusForId(3700)).to.equal(ethers.parseEther("2000"));
    expect(await nft.bonusForId(3701)).to.equal(ethers.parseEther("4000"));
    expect(await nft.bonusForId(4200)).to.equal(ethers.parseEther("4000"));
    expect(await nft.bonusForId(4201)).to.equal(ethers.parseEther("8000"));
    expect(await nft.bonusForId(4380)).to.equal(ethers.parseEther("8000"));
    expect(await nft.bonusForId(4381)).to.equal(ethers.parseEther("16000"));
    expect(await nft.bonusForId(4443)).to.equal(ethers.parseEther("16000"));
    expect(await nft.bonusForId(4444)).to.equal(ethers.parseEther("32000"));
    expect(await nft.rarityOf(1)).to.equal("Common");
    expect(await nft.rarityOf(3001)).to.equal("Uncommon");
    expect(await nft.rarityOf(3701)).to.equal("Rare");
    expect(await nft.rarityOf(4201)).to.equal("Epic");
    expect(await nft.rarityOf(4381)).to.equal("Legendary");
    expect(await nft.rarityOf(4444)).to.equal("Limited");
    expect(await nft.tierNameOf(1)).to.equal("Bluebird");
    expect(await nft.tierNameOf(3001)).to.equal("Honeybee");
    expect(await nft.tierNameOf(3701)).to.equal("Lovebirds");
    expect(await nft.tierNameOf(4201)).to.equal("Golden Duo");
    expect(await nft.tierNameOf(4381)).to.equal("Royal Duo");
    expect(await nft.tierNameOf(4444)).to.equal("True Love");
  });

  it("mint reverts while closed: mintFree and mintPaid both", async function () {
    const NFT = await ethers.getContractFactory("BirdAndBees");
    const closed = await NFT.deploy(BASE_URI, owner.address, await registry.getAddress(), await token.getAddress());
    await expect(closed.connect(agent1).mintFree()).to.be.revertedWithCustomError(closed, "MintClosed");
    await expect(closed.connect(stranger).mintPaid(1, { value: PRICE_SINGLE }))
      .to.be.revertedWithCustomError(closed, "MintClosed");
  });

  it("free lane gate: non-agent reverts, contract caller reverts", async function () {
    await expect(nft.connect(stranger).mintFree()).to.be.revertedWithCustomError(nft, "NotAgent");
    const Caller = await ethers.getContractFactory("MintCaller");
    const caller = await Caller.deploy();
    await expect(caller.callMintFree(await nft.getAddress())).to.be.revertedWith("call failed");
  });

  it("quotePaidFor/pricing: 1x0.0005, 2x0.001, 4x0.002, 5-pack 0.0024, 6th reverts", async function () {
    expect(await nft.quotePaidFor(agent1.address, 1)).to.equal(PRICE_SINGLE);
    expect(await nft.quotePaidFor(agent1.address, 2)).to.equal(PRICE_SINGLE * 2n);
    expect(await nft.quotePaidFor(agent1.address, 4)).to.equal(PRICE_SINGLE * 4n);
    expect(await nft.quotePaidFor(agent1.address, 5)).to.equal(PRICE_PACK_5);
    await expect(nft.quotePaidFor(agent1.address, 6)).to.be.revertedWithCustomError(nft, "OverLimit");
    await expect(nft.quotePaidFor(agent1.address, 0)).to.be.revertedWithCustomError(nft, "OverLimit");
    expect(await nft.priceWei()).to.equal(PRICE_SINGLE);
    expect(await nft.pricePack5()).to.equal(PRICE_PACK_5);
  });

  it("free mint: agent claims a Common id (1-3000), accrues 0 BNTB; second free reverts", async function () {
    const tx = await nft.connect(agent1).mintFree();
    const ids = await mintedIds(nft, tx);
    expect(ids.length).to.equal(1);
    freeId = ids[0];
    expect(freeId).to.be.at.least(1).and.at.most(3000); // Common only
    expect(await nft.ownerOf(freeId)).to.equal(agent1.address);
    expect(await nft.totalMinted()).to.equal(1);
    expect(await nft.freeMinted()).to.equal(1);
    expect(await nft.paidMinted()).to.equal(0);
    expect(await nft.mintedOf(agent1.address)).to.equal(1);
    expect(await nft.freeMintedOf(agent1.address)).to.equal(1);
    expect(await nft.paidMintedOf(agent1.address)).to.equal(0);
    expect(await nft.freeRemaining()).to.equal(2999);
    expect(await token.accrued(agent1.address)).to.equal(0);
    expect(await token.claimable(agent1.address)).to.equal(0);
    expect(await nft.tokenURI(freeId)).to.equal(BASE_URI + freeId);
    expect(await nft.exists(freeId)).to.equal(true);
    expect(await nft.exists(3001)).to.equal(false);
    await expect(nft.connect(agent1).mintFree()).to.be.revertedWithCustomError(nft, "FreeClaimed");
  });

  it("paid singles by PUBLIC wallet: 5 singles, ids 3001-4444, bonus by rarity drawn", async function () {
    const ownerBefore = await ethers.provider.getBalance(owner.address);
    const allIds = [];
    for (let i = 0; i < 5; i++) {
      const tx = await nft.connect(stranger).mintPaid(1, { value: PRICE_SINGLE });
      const ids = await mintedIds(nft, tx);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.be.at.least(3001).and.at.most(4444); // Uncommon through Limited
      allIds.push(ids[0]);
    }
    expect(new Set(allIds).size).to.equal(5); // all distinct
    expect(await nft.paidMinted()).to.equal(5);
    expect(await nft.paidMintedOf(stranger.address)).to.equal(5);
    expect(await nft.mintedOf(stranger.address)).to.equal(5);
    expect(await nft.freeMintedOf(stranger.address)).to.equal(0);
    strangerBonus = allIds.reduce((sum, id) => sum + bonusForId(id), 0n);
    expect(await token.accrued(stranger.address)).to.equal(strangerBonus);
    expect(await token.claimable(stranger.address)).to.equal(strangerBonus);
    const ownerAfter = await ethers.provider.getBalance(owner.address);
    expect(ownerAfter - ownerBefore).to.equal(PRICE_SINGLE * 5n);
    expect(await ethers.provider.getBalance(await nft.getAddress())).to.equal(0);
    // public wallet has hit the 5-paid cap; a 6th paid mint reverts
    await expect(nft.connect(stranger).mintPaid(1, { value: PRICE_SINGLE }))
      .to.be.revertedWithCustomError(nft, "OverLimit");
  });

  it("agent full path: free + 5-pack = 6 total, pack ids 3001-4444, then caps bind", async function () {
    const tx = await nft.connect(agent1).mintPaid(5, { value: PRICE_PACK_5 });
    const ids = await mintedIds(nft, tx);
    expect(ids.length).to.equal(5);
    expect(new Set(ids).size).to.equal(5);
    for (const id of ids) {
      expect(id).to.be.at.least(3001).and.at.most(4444);
      expect(await nft.ownerOf(id)).to.equal(agent1.address);
    }
    expect(await nft.mintedOf(agent1.address)).to.equal(6);
    expect(await nft.paidMintedOf(agent1.address)).to.equal(5);
    expect(await nft.freeMintedOf(agent1.address)).to.equal(1);
    expect(await nft.paidMinted()).to.equal(10);
    expect(await nft.totalMinted()).to.equal(11);
    agent1PackBonus = ids.reduce((sum, id) => sum + bonusForId(id), 0n);
    expect(await token.accrued(agent1.address)).to.equal(agent1PackBonus);
    expect(await token.totalAccrued()).to.equal(strangerBonus + agent1PackBonus);
    await expect(nft.connect(agent1).mintPaid(1, { value: PRICE_SINGLE }))
      .to.be.revertedWithCustomError(nft, "OverLimit");
    await expect(nft.connect(agent1).mintFree()).to.be.revertedWithCustomError(nft, "FreeClaimed");
  });

  it("underpaid reverts with required amount", async function () {
    await expect(
      nft.connect(agent2).mintPaid(1, { value: ethers.parseEther("0.00025") })
    ).to.be.revertedWithCustomError(nft, "Underpaid");
    // 5-pack costs 0.0024; send 0.001.
    await expect(
      nft.connect(agent2).mintPaid(5, { value: ethers.parseEther("0.001") })
    ).to.be.revertedWithCustomError(nft, "Underpaid");
  });

  it("overpay is refunded in full (mintPaid 2 with 1 BNB)", async function () {
    const before = await ethers.provider.getBalance(agent2.address);
    const tx = await nft.connect(agent2).mintPaid(2, { value: ethers.parseEther("1") });
    const receipt = await tx.wait();
    const gas = receipt.gasUsed * receipt.gasPrice;
    const after = await ethers.provider.getBalance(agent2.address);
    expect(before - after - gas).to.equal(PRICE_SINGLE * 2n);
    const ids = await mintedIds(nft, tx);
    expect(ids.length).to.equal(2);
    for (const id of ids) expect(id).to.be.at.least(3001).and.at.most(4444);
    expect(await nft.mintedOf(agent2.address)).to.equal(2);
    expect(await nft.paidMintedOf(agent2.address)).to.equal(2);
    const expectedBonus = ids.reduce((sum, id) => sum + bonusForId(id), 0n);
    expect(await token.accrued(agent2.address)).to.equal(expectedBonus);
    expect(await nft.totalMinted()).to.equal(13);
    expect(await nft.paidMinted()).to.equal(12);
    expect(await nft.freeMinted()).to.equal(1);
    // qty 0 and qty 6 revert
    await expect(nft.connect(agent2).mintPaid(0)).to.be.revertedWithCustomError(nft, "OverLimit");
    await expect(nft.connect(agent2).mintPaid(6, { value: PRICE_PACK_5 }))
      .to.be.revertedWithCustomError(nft, "OverLimit");
  });

  it("claim: pays accrued BNTB, second claim reverts, claimFor works", async function () {
    expect(await token.claimable(agent1.address)).to.equal(agent1PackBonus);
    await expect(token.connect(agent1).claim())
      .to.emit(token, "Claimed").withArgs(agent1.address, agent1PackBonus);
    expect(await token.balanceOf(agent1.address)).to.equal(agent1PackBonus);
    expect(await token.claimable(agent1.address)).to.equal(0);
    expect(await token.claimed(agent1.address)).to.equal(agent1PackBonus);
    await expect(token.connect(agent1).claim()).to.be.revertedWithCustomError(token, "NothingToClaim");
    // claimFor: anyone can trigger a beneficiary's claim
    await expect(token.connect(agent2).claimFor(stranger.address))
      .to.emit(token, "Claimed").withArgs(stranger.address, strangerBonus);
    expect(await token.balanceOf(stranger.address)).to.equal(strangerBonus);
  });

  it("token caps: accrue only by minter, wallet cap 160,000 enforced", async function () {
    await expect(token.connect(stranger).accrue(agent1.address, ethers.parseEther("1000")))
      .to.be.revertedWithCustomError(token, "NotMinter");
    // fresh token with a test signer as minter to probe caps directly
    const Token = await ethers.getContractFactory("BntbToken");
    const t2 = await Token.deploy(owner.address);
    await t2.connect(owner).setMinter(stranger.address);
    await t2.connect(stranger).accrue(buyer.address, ethers.parseEther("160000"));
    await expect(t2.connect(stranger).accrue(buyer.address, 1))
      .to.be.revertedWithCustomError(t2, "OverWalletCap");
    expect(await t2.totalAccrued()).to.equal(ethers.parseEther("160000"));
  });

  it("royaltyInfo: 5% to owner", async function () {
    const [receiver, amount] = await nft.royaltyInfo(freeId, ethers.parseEther("1"));
    expect(receiver).to.equal(owner.address);
    expect(amount).to.equal(ethers.parseEther("0.05"));
    const [, amount2] = await nft.royaltyInfo(freeId, ethers.parseEther("2"));
    expect(amount2).to.equal(ethers.parseEther("0.1"));
  });

  it("owner switches: setMintOpen / setBaseURI, non-owner reverts", async function () {
    await expect(nft.connect(stranger).setMintOpen(false)).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    await nft.connect(owner).setBaseURI("https://example.com/meta/");
    expect(await nft.tokenURI(freeId)).to.equal("https://example.com/meta/" + freeId);
    await nft.connect(owner).setBaseURI(BASE_URI);
    await expect(nft.connect(stranger).setBaseURI("x")).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
  });

  it("pool boundary: drain the combined paid+top pool, paid reverts SoldOut, free still works", async function () {
    // Fresh instance so the pools are full.
    const Token = await ethers.getContractFactory("BntbToken");
    const t2 = await Token.deploy(owner.address);
    const NFT = await ethers.getContractFactory("BirdAndBees");
    const n2 = await NFT.deploy(BASE_URI, owner.address, await registry.getAddress(), await t2.getAddress());
    await t2.connect(owner).setMinter(await n2.getAddress());
    await n2.connect(owner).setMintOpen(true);

    // Drain the 1,444-id combined paid+top pool: 288 wallets x 5-pack + 1 wallet x 4 singles.
    const wallets = [];
    for (let i = 0; i < 289; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      wallets.push(w);
      await ethers.provider.send("hardhat_setBalance", [w.address, "0x8AC7230489E80000"]); // 10 ETH
    }
    for (let i = 0; i < 288; i++) {
      await n2.connect(wallets[i]).mintPaid(5, { value: PRICE_PACK_5 });
    }
    await n2.connect(wallets[288]).mintPaid(4, { value: PRICE_SINGLE * 4n });
    expect(await n2.paidRemaining()).to.equal(0);
    expect(await n2.topRemaining()).to.equal(0);
    expect(await n2.totalMinted()).to.equal(1444);

    // Paid mints now revert SoldOut (combined pool empty).
    const fresh = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [fresh.address, "0x8AC7230489E80000"]);
    await expect(n2.connect(fresh).mintPaid(1, { value: PRICE_SINGLE }))
      .to.be.revertedWithCustomError(n2, "SoldOut");
    await expect(n2.connect(fresh).mintPaid(5, { value: PRICE_PACK_5 }))
      .to.be.revertedWithCustomError(n2, "SoldOut");
    await expect(n2.quotePaidFor(fresh.address, 1)).to.be.revertedWithCustomError(n2, "SoldOut");

    // Free lane still works — the Common pool (3,000) is untouched.
    await registry.mint(fresh.address);
    const freeTx = await n2.connect(fresh).mintFree();
    const freeIds = await mintedIds(n2, freeTx);
    expect(freeIds.length).to.equal(1);
    expect(freeIds[0]).to.be.at.least(1).and.at.most(3000);
    expect(await n2.freeRemaining()).to.equal(2999);
    expect(await n2.totalMinted()).to.equal(1445);
  });
});
