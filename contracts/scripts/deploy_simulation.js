// Bird and The Bees deploy SIMULATION ONLY — no mainnet transaction is sent by this script.
// Computes CREATE2 predicted addresses exactly as the deterministic-proxy
// route did for HakunaAgent/NEKART/LunarAgentRion/MiChan/PanduAGENT/Sakura,
// and measures gas on the local network. Deploy order: BNTB token first
// (constructor: owner only), then the Bird and The Bees NFT (constructor:
// baseURI, owner, Agent ID registry, predicted BNTB address — the token
// deploys first, so its address is known), then the BirdAndBeesMarketplace
// (constructor: predicted NFT address).
// After deploy the owner must call token.setMinter(nft). Mint stays CLOSED
// (mintOpen=false in the constructor) until the owner calls
// setMintOpen(true) — that opening step is a separate owner call, and per
// the user's launch sequence it happens only after preparations are done.
// TWO-LANE RANDOM model (user-confirmed 2026-11-12):
// mintFree() is Agent ID only, draws Common ids 1-3000 (Bluebird), free cap 3,000;
// mintPaid(qty) is PUBLIC: singles 0.0005 BNB and 5-pack 0.0024 BNB both draw
// ids 3001-4444 (Uncommon through Limited) — a single paid mint CAN reach
// Legendary + Limited, chance very small (natural deck odds). The 5-pack
// adds a 1-in-20 lucky redirect per draw toward the top pool — a slight
// lift to the top-3 odds, never a guarantee. Max 5 paid / 6 total per wallet.
// Bonus BNTB per paid mint BY RARITY: Common 1,000 / Uncommon 2,000 /
// Rare 4,000 / Epic 8,000 / Legendary 16,000 / Limited 32,000.
// Custom domain: bntb.fun (baseURI https://bntb.fun/metadata/).
// Run: npx hardhat run scripts/deploy_simulation.js
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const BASE_URI = "https://bntb.fun/metadata/";
const OWNER = "0x36F3D56eAD5D1D6C2434F94DeFcEF732C5C3CbD2";
const AGENT_ID = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F"; // SPACE ID Agent ID registry
const PROXY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"; // deterministic deployment proxy
// Canonical deterministic-deployment-proxy creation code (deploys the proxy
// itself; used here only on the local network so the CREATE2 call can be
// gas-estimated with identical bytecode).
const PROXY_CREATION =
  "0x604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

function predict(artifact, argTypes, argValues) {
  const args = ethers.AbiCoder.defaultAbiCoder().encode(argTypes, argValues);
  const creation = artifact.bytecode + args.slice(2);
  const predicted = ethers.getCreate2Address(PROXY, ethers.ZeroHash, ethers.keccak256(creation));
  const inputData = "0x" + "00".repeat(32) + creation.slice(2);
  return { creation, predicted, inputData };
}

async function main() {
  const outDir = path.join(__dirname, "..");
  const [deployer, agent, packBuyer] = await ethers.getSigners();

  // --- BNTB token: predict first (constructor args: owner) ---
  const tokenArtifact = await hre.artifacts.readArtifact("BntbToken");
  const tokenPred = predict(tokenArtifact, ["address"], [OWNER]);

  // --- NFT: predict (constructor args: baseURI, owner, agentId, token=predicted) ---
  const nftArtifact = await hre.artifacts.readArtifact("BirdAndBees");
  const nftPred = predict(
    nftArtifact,
    ["string", "address", "address", "address"],
    [BASE_URI, OWNER, AGENT_ID, tokenPred.predicted]
  );

  // --- Marketplace: predict (constructor args: nft=predicted) ---
  const marketFactory = await ethers.getContractFactory("BirdAndBeesMarketplace");
  const marketDeployTx = await marketFactory.getDeployTransaction(nftPred.predicted);
  const marketCreation = marketDeployTx.data;
  const marketPredicted = ethers.getCreate2Address(PROXY, ethers.ZeroHash, ethers.keccak256(marketCreation));
  const marketInputData = ethers.hexlify(ethers.concat([ethers.ZeroHash, marketCreation]));

  fs.writeFileSync(path.join(outDir, "token_creation.txt"), tokenPred.creation);
  fs.writeFileSync(path.join(outDir, "token_inputdata.txt"), tokenPred.inputData);
  fs.writeFileSync(path.join(outDir, "token_predicted.txt"), tokenPred.predicted);
  fs.writeFileSync(path.join(outDir, "nft_creation.txt"), nftPred.creation);
  fs.writeFileSync(path.join(outDir, "nft_inputdata.txt"), nftPred.inputData);
  fs.writeFileSync(path.join(outDir, "nft_predicted.txt"), nftPred.predicted);
  fs.writeFileSync(path.join(outDir, "market_creation.txt"), marketCreation);
  fs.writeFileSync(path.join(outDir, "market_inputdata.txt"), marketInputData);
  fs.writeFileSync(path.join(outDir, "market_predicted.txt"), marketPredicted);

  // --- Local deploy + gas measurements ---
  const Token = await ethers.getContractFactory("BntbToken");
  const token = await Token.deploy(OWNER);
  const tokenDeployReceipt = await token.deploymentTransaction().wait();

  const NFT = await ethers.getContractFactory("BirdAndBees");
  const nft = await NFT.deploy(BASE_URI, OWNER, AGENT_ID, await token.getAddress());
  const nftDeployReceipt = await nft.deploymentTransaction().wait();

  const market = await marketFactory.deploy(await nft.getAddress());
  const marketDeployReceipt = await market.deploymentTransaction().wait();

  // Constructor must leave mint CLOSED.
  const mintOpenAtDeploy = await nft.mintOpen();
  if (mintOpenAtDeploy !== false) throw new Error("mintOpen is not false at deploy");

  // Owner wiring (deployer is NOT the owner locally, so impersonate owner).
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [OWNER] });
  await hre.network.provider.request({
    method: "hardhat_setBalance",
    params: [OWNER, "0x8AC7230489E80000"], // 10 ETH
  });
  const ownerSigner = await ethers.getSigner(OWNER);
  const setMinterTx = await token.connect(ownerSigner).setMinter(await nft.getAddress());
  const setMinterReceipt = await setMinterTx.wait();
  const setBaseTx = await nft.connect(ownerSigner).setBaseURI(BASE_URI);
  const setBaseReceipt = await setBaseTx.wait();
  const openTx = await nft.connect(ownerSigner).setMintOpen(true);
  const openReceipt = await openTx.wait();

  // Gas check on a live mint path (local only): 1 free + 5 singles + 5-pack + claim.
  // Uses a second token/NFT pair wired to mocks, because the first token's
  // minter is already locked to the first NFT and the first NFT points at
  // the real registry.
  const Mock = await ethers.getContractFactory("MockAgentID");
  const registry = await Mock.deploy();
  await registry.mint(agent.address);
  const token2 = await Token.deploy(OWNER);
  const nft2 = await NFT.deploy(BASE_URI, OWNER, await registry.getAddress(), await token2.getAddress());
  await token2.connect(ownerSigner).setMinter(await nft2.getAddress());
  await nft2.connect(ownerSigner).setBaseURI(BASE_URI);
  await nft2.connect(ownerSigner).setMintOpen(true);
  const freeTx = await nft2.connect(agent).mintFree();
  const freeReceipt = await freeTx.wait();
  const singleTx = await nft2.connect(agent).mintPaid(1, { value: ethers.parseEther("0.0005") });
  const singleReceipt = await singleTx.wait();
  // The 5-pack uses a fresh public wallet (no free claimed): agent already
  // holds 1 free + 1 single, and 1 + 1 + 5 = 7 would exceed the 6/wallet cap.
  const packTx = await nft2.connect(packBuyer).mintPaid(5, { value: ethers.parseEther("0.0024") });
  const packReceipt = await packTx.wait();
  const claimTx = await token2.connect(agent).claim();
  const claimReceipt = await claimTx.wait();

  // Rarity/bonus spot checks (pure view functions).
  const bonusCommon = await nft2.bonusForId(1);
  const bonusUncommon = await nft2.bonusForId(3001);
  const bonusRare = await nft2.bonusForId(3701);
  const bonusEpic = await nft2.bonusForId(4201);
  const bonusLegendary = await nft2.bonusForId(4381);
  const bonusLimited = await nft2.bonusForId(4444);
  const rarityLimited = await nft2.rarityOf(4444);
  const tierLimited = await nft2.tierNameOf(4444);

  // Marketplace gas via the local proxy (identical bytecode to mainnet route).
  const proxyDeployTx = await deployer.sendTransaction({ data: PROXY_CREATION });
  const proxyReceipt = await proxyDeployTx.wait();
  const localProxy = proxyReceipt.contractAddress;
  const gasViaProxy = await ethers.provider.estimateGas({ to: localProxy, data: marketInputData });
  const gasPriceWei = 50_000_000n; // 0.05 gwei, as measured on BSC
  const totalGas =
    tokenDeployReceipt.gasUsed + nftDeployReceipt.gasUsed + gasViaProxy + setMinterReceipt.gasUsed;
  const totalCostBnb = Number(totalGas * gasPriceWei) / 1e18;

  const result = {
    token: {
      contract: "BntbToken",
      name: "BNTB",
      symbol: "BNTB",
      totalSupply: "1000000000",
      bonusPool: "540000000",
      treasury: "460000000",
      owner: OWNER,
      deterministicProxy: PROXY,
      predictedAddress: tokenPred.predicted,
      creationBytes: (tokenPred.creation.length - 2) / 2,
      inputDataBytes: (tokenPred.inputData.length - 2) / 2,
      creationCodeKeccak: ethers.keccak256(tokenPred.creation),
      gas: {
        deploy: Number(tokenDeployReceipt.gasUsed),
        setMinter: Number(setMinterReceipt.gasUsed),
        claim: Number(claimReceipt.gasUsed),
      },
      localDeployAddress: await token.getAddress(),
    },
    nft: {
      contract: "BirdAndBees",
      name: "Bird and The Bees",
      symbol: "BNTB",
      baseURI: BASE_URI,
      owner: OWNER,
      agentIdRegistry: AGENT_ID,
      token: tokenPred.predicted,
      maxSupply: 4444,
      maxPerWallet: 6,
      model: "two-lane random: mintFree() agent-only (Common 1-3000), mintPaid(uint256) public (singles + 5-pack both draw 3001-4444 @ 0.0005 / 0.0024, 5-pack adds 1-in-20 top-pool redirect)",
      priceSingleBnb: "0.0005",
      pricePack5Bnb: "0.0024",
      freeCap: 3000,
      bonusByRarity: {
        Common: "1000",
        Uncommon: "2000",
        Rare: "4000",
        Epic: "8000",
        Legendary: "16000",
        Limited: "32000",
      },
      bonusSpotCheck: {
        id1: ethers.formatEther(bonusCommon),
        id3001: ethers.formatEther(bonusUncommon),
        id3701: ethers.formatEther(bonusRare),
        id4201: ethers.formatEther(bonusEpic),
        id4381: ethers.formatEther(bonusLegendary),
        id4444: ethers.formatEther(bonusLimited),
        rarity4444: rarityLimited,
        tier4444: tierLimited,
      },
      deterministicProxy: PROXY,
      predictedAddress: nftPred.predicted,
      creationBytes: (nftPred.creation.length - 2) / 2,
      inputDataBytes: (nftPred.inputData.length - 2) / 2,
      creationCodeKeccak: ethers.keccak256(nftPred.creation),
      gas: {
        deploy: Number(nftDeployReceipt.gasUsed),
        setBaseURI: Number(setBaseReceipt.gasUsed),
        setMintOpen: Number(openReceipt.gasUsed),
        freeMint: Number(freeReceipt.gasUsed),
        paidSingle: Number(singleReceipt.gasUsed),
        paidPack5: Number(packReceipt.gasUsed),
      },
      mintOpenAtDeploy: mintOpenAtDeploy,
      localDeployAddress: await nft.getAddress(),
    },
    marketplace: {
      contract: "BirdAndBeesMarketplace",
      nft: nftPred.predicted,
      platformFee: "0%",
      royalty: "5% via royaltyInfo, fallback 5% to owner",
      deterministicProxy: PROXY,
      predictedAddress: marketPredicted,
      creationBytes: (marketCreation.length - 2) / 2,
      inputDataBytes: (marketInputData.length - 2) / 2,
      creationCodeKeccak: ethers.keccak256(marketCreation),
      gas: {
        deployPlain: Number(marketDeployReceipt.gasUsed),
        deployViaProxy: gasViaProxy.toString(),
      },
      localDeployAddress: await market.getAddress(),
    },
    totalDeployGas: totalGas.toString(),
    totalDeployCostBnbAt0_05gwei: totalCostBnb,
    note: "SIMULATION ONLY — no mainnet transaction was sent. Predicted addresses are CREATE2 addresses via the deterministic deployment proxy with salt 0 (same route as Archon/Sonofluidic/HATCHIEggy/NEKART/LunarAgentRion/HakunaAgent/MiChan/PanduAGENT/Sakura, whose predictions matched on-chain exactly). Mint stays CLOSED after deploy (mintOpen=false in the constructor); opening requires a separate owner setMintOpen(true) call, and token.setMinter(nft) must be called by the owner after the NFT deploys.",
  };
  fs.writeFileSync(path.join(outDir, "deploy_simulation.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
