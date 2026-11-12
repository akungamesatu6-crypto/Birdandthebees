// BirdAndBeesMarketplace tests — fixed-price escrow, 0% platform fee,
// 5% royalty via ERC-2981 with hardcoded fallback. Adapted from the
// Sakura marketplace suite (same structure, Bird and The Bees NFT).
// Note: Bird and The Bees mints are RANDOM, so the seller's token ids are
// captured from the Minted events instead of assumed sequential.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const BASE_URI = "https://bntb.fun/metadata/";
const PRICE_SINGLE = ethers.parseEther("0.0005");
const PRICE_ALL_4 = PRICE_SINGLE * 4n; // 0.002

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

describe("BirdAndBeesMarketplace", function () {
  let owner, seller, buyer, stranger;
  let registry, token, nft, market, noRoyalty;
  let idFree, idPaid1, idPaid2;

  before(async function () {
    [owner, seller, buyer, stranger] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockAgentID");
    registry = await Mock.deploy();
    await registry.mint(seller.address);
    await registry.mint(buyer.address);

    const Token = await ethers.getContractFactory("BntbToken");
    token = await Token.deploy(owner.address);

    const NFT = await ethers.getContractFactory("BirdAndBees");
    nft = await NFT.deploy(BASE_URI, owner.address, await registry.getAddress(), await token.getAddress());
    await token.connect(owner).setMinter(await nft.getAddress());
    await nft.connect(owner).setMintOpen(true);
    // seller holds 1 free (Common) + 4 paid singles (3001-4444)
    idFree = (await mintedIds(nft, await nft.connect(seller).mintFree()))[0];
    const paid = await mintedIds(nft, await nft.connect(seller).mintPaid(4, { value: PRICE_ALL_4 }));
    [idPaid1, idPaid2] = [paid[0], paid[1]];

    const Market = await ethers.getContractFactory("BirdAndBeesMarketplace");
    market = await Market.deploy(await nft.getAddress());

    const NoRoyalty = await ethers.getContractFactory("MockERC721NoRoyalty");
    noRoyalty = await NoRoyalty.deploy();
    await noRoyalty.mint(seller.address, 99);
  });

  it("constructor: rejects zero NFT address, stores NFT", async function () {
    const Market = await ethers.getContractFactory("BirdAndBeesMarketplace");
    await expect(Market.deploy(ethers.ZeroAddress)).to.be.revertedWith("zero nft");
    expect(await market.nft()).to.equal(await nft.getAddress());
    expect(await market.getListedIds()).to.deep.equal([]);
  });

  it("list: escrows the NFT, shows in getListedIds/getListing", async function () {
    await nft.connect(seller).setApprovalForAll(await market.getAddress(), true);
    await expect(market.connect(seller).list(idFree, ethers.parseEther("1")))
      .to.emit(market, "Listed").withArgs(idFree, seller.address, ethers.parseEther("1"));
    expect(await nft.ownerOf(idFree)).to.equal(await market.getAddress());
    expect(await market.getListedIds()).to.deep.equal([BigInt(idFree)]);
    const [s, p, a] = await market.getListing(idFree);
    expect(s).to.equal(seller.address);
    expect(p).to.equal(ethers.parseEther("1"));
    expect(a).to.equal(true);
  });

  it("list errors: price 0, already listed, not owner", async function () {
    await expect(market.connect(seller).list(idPaid1, 0)).to.be.revertedWith("price 0");
    await expect(market.connect(seller).list(idFree, ethers.parseEther("1"))).to.be.revertedWith("already listed");
    await expect(market.connect(stranger).list(idPaid1, ethers.parseEther("1"))).to.be.revertedWith("not owner");
  });

  it("updatePrice: seller only, new price visible", async function () {
    await expect(market.connect(stranger).updatePrice(idFree, ethers.parseEther("2"))).to.be.revertedWith("not seller");
    await expect(market.connect(seller).updatePrice(idFree, 0)).to.be.revertedWith("price 0");
    await expect(market.connect(seller).updatePrice(idFree, ethers.parseEther("2")))
      .to.emit(market, "PriceUpdated").withArgs(idFree, ethers.parseEther("2"));
    const [, p] = await market.getListing(idFree);
    expect(p).to.equal(ethers.parseEther("2"));
    // back to 1 BNB for the buy test
    await market.connect(seller).updatePrice(idFree, ethers.parseEther("1"));
  });

  it("buy: exact payment, 5% royalty to owner, 95% to seller, NFT to buyer", async function () {
    const price = ethers.parseEther("1");
    const royalty = ethers.parseEther("0.05");
    const ownerBefore = await ethers.provider.getBalance(owner.address);
    const sellerBefore = await ethers.provider.getBalance(seller.address);
    await expect(market.connect(buyer).buy(idFree, { value: price }))
      .to.emit(market, "Sale").withArgs(idFree, seller.address, buyer.address, price, royalty);
    expect(await nft.ownerOf(idFree)).to.equal(buyer.address);
    expect(await market.getListedIds()).to.deep.equal([]);
    const [, , active] = await market.getListing(idFree);
    expect(active).to.equal(false);
    expect((await ethers.provider.getBalance(owner.address)) - ownerBefore).to.equal(royalty);
    expect((await ethers.provider.getBalance(seller.address)) - sellerBefore).to.equal(price - royalty);
    expect(await ethers.provider.getBalance(await market.getAddress())).to.equal(0);
  });

  it("buy errors: not listed, seller cannot buy, wrong value", async function () {
    await market.connect(seller).list(idPaid1, ethers.parseEther("1"));
    await expect(market.connect(buyer).buy(idPaid2)).to.be.revertedWith("not listed");
    await expect(market.connect(seller).buy(idPaid1)).to.be.revertedWith("seller cannot buy");
    await expect(market.connect(buyer).buy(idPaid1, { value: ethers.parseEther("0.5") }))
      .to.be.revertedWith("exact price required");
    await expect(market.connect(buyer).buy(idPaid1, { value: ethers.parseEther("2") }))
      .to.be.revertedWith("exact price required");
  });

  it("cancel: only seller, NFT returns, listing removed", async function () {
    await expect(market.connect(stranger).cancel(idPaid1)).to.be.revertedWith("not seller");
    await expect(market.connect(seller).cancel(idPaid1))
      .to.emit(market, "Cancelled").withArgs(idPaid1, seller.address);
    expect(await nft.ownerOf(idPaid1)).to.equal(seller.address);
    expect(await market.getListedIds()).to.deep.equal([]);
  });

  it("re-list after cancel works; multiple listings enumerate", async function () {
    await market.connect(seller).list(idPaid1, ethers.parseEther("0.5"));
    await market.connect(seller).list(idPaid2, ethers.parseEther("0.75"));
    expect(await market.getListedIds()).to.deep.equal([BigInt(idPaid1), BigInt(idPaid2)]);
    // cancel first: list order [idPaid1, idPaid2], cancel idPaid1 -> [idPaid2]
    await market.connect(seller).cancel(idPaid1);
    expect(await market.getListedIds()).to.deep.equal([BigInt(idPaid2)]);
    await market.connect(seller).cancel(idPaid2);
    expect(await market.getListedIds()).to.deep.equal([]);
  });

  it("royalty fallback: no-royalty NFT pays hardcoded 5% to owner wallet", async function () {
    const Market = await ethers.getContractFactory("BirdAndBeesMarketplace");
    const m2 = await Market.deploy(await noRoyalty.getAddress());
    await noRoyalty.connect(seller).setApprovalForAll(await m2.getAddress(), true);
    await m2.connect(seller).list(99, ethers.parseEther("2"));
    const fallbackReceiver = await m2.ROYALTY_FALLBACK_RECEIVER();
    expect(fallbackReceiver).to.equal("0x36F3D56eAD5D1D6C2434F94DeFcEF732C5C3CbD2");
    const before = await ethers.provider.getBalance(fallbackReceiver);
    const sellerBefore = await ethers.provider.getBalance(seller.address);
    await expect(m2.connect(buyer).buy(99, { value: ethers.parseEther("2") }))
      .to.emit(m2, "Sale").withArgs(99, seller.address, buyer.address, ethers.parseEther("2"), ethers.parseEther("0.1"));
    expect(await noRoyalty.ownerOf(99)).to.equal(buyer.address);
    expect((await ethers.provider.getBalance(fallbackReceiver)) - before).to.equal(ethers.parseEther("0.1"));
    expect((await ethers.provider.getBalance(seller.address)) - sellerBefore).to.equal(ethers.parseEther("1.9"));
  });

  it("onERC721Received accepts escrowed NFTs", async function () {
    const sel = await market.onERC721Received.staticCall(seller.address, seller.address, idFree, "0x");
    expect(sel).to.equal("0x150b7a02");
  });
});
