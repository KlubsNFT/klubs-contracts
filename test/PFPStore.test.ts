import { PFPStore, PFPs, TestMix, TestPFP } from "../typechain";
import { mine, mineTo, autoMining, getBlock } from "./utils/blockchain";

import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber, BigNumberish, Contract } from "ethers";

const { constants } = ethers;
const { MaxUint256, Zero, AddressZero } = constants;

const setupTest = async () => {
    const signers = await ethers.getSigners();
    const [deployer, alice, bob, carol, dan, pfpManager, pfp2Manager, pfp3Manager] = signers;

    const TestMix = await ethers.getContractFactory("TestMix");
    const mix = (await TestMix.deploy()) as TestMix;

    const TestPFP = await ethers.getContractFactory("TestPFP");
    const pfp = (await TestPFP.deploy()) as TestPFP;
    const pfp2 = (await TestPFP.deploy()) as TestPFP;
    const pfp3 = (await TestPFP.deploy()) as TestPFP;

    const PFPs = await ethers.getContractFactory("PFPs");
    const pfps = (await PFPs.deploy()) as PFPs;

    await pfps.addByOwner(pfp.address, pfpManager.address);
    await pfps.addByOwner(pfp2.address, pfp2Manager.address);

    const PFPStore = await ethers.getContractFactory("PFPStore");
    const pfpStore = (await PFPStore.deploy(pfps.address, mix.address)) as PFPStore;

    await mix.mint(alice.address, 100000000);
    await mix.mint(bob.address, 100000000);
    await mix.mint(carol.address, 100000000);
    await mix.mint(dan.address, 100000000);

    await mix.approve(pfpStore.address, MaxUint256);
    await mix.connect(alice).approve(pfpStore.address, MaxUint256);
    await mix.connect(bob).approve(pfpStore.address, MaxUint256);
    await mix.connect(carol).approve(pfpStore.address, MaxUint256);
    await mix.connect(dan).approve(pfpStore.address, MaxUint256);

    await mineTo((await pfpStore.auctionExtensionInterval()).toNumber());

    return {
        deployer,
        alice,
        bob,
        carol,
        dan,
        mix,
        pfp,
        pfp2,
        pfp3,
        pfps,
        pfpStore,
        pfpManager,
        pfp2Manager,
        pfp3Manager,
    };
};

describe("PFPStore", () => {
    beforeEach(async () => {
        await ethers.provider.send("hardhat_reset", []);
    });

    it("should be that basic functions and variables related with fee work properly", async () => {
        const { deployer, alice, bob, carol, dan, mix, pfp, pfps, pfpManager, pfpStore } = await setupTest();

        await expect(pfpStore.connect(alice).setFee(100)).to.be.reverted;
        await expect(pfpStore.setFee(9000)).to.be.reverted;

        expect(await pfpStore.fee()).to.be.equal(25);
        await pfpStore.setFee(8999);
        expect(await pfpStore.fee()).to.be.equal(8999);

        await expect(pfpStore.connect(alice).setFeeReceiver(alice.address)).to.be.reverted;

        expect(await pfpStore.feeReceiver()).to.be.equal(deployer.address);
        await pfpStore.setFeeReceiver(alice.address);
        expect(await pfpStore.feeReceiver()).to.be.equal(alice.address);

        await pfp.massMint(bob.address, 4);
        await pfp.connect(bob).setApprovalForAll(pfpStore.address, true);

        await pfpStore.connect(bob).sell([pfp.address], [0], [1000]);
        await expect(() => pfpStore.connect(carol).buy([pfp.address], [0])).to.changeTokenBalances(
            mix,
            [alice, bob, pfpManager, carol],
            [899, 101, 0, -1000]
        );
        expect(await pfp.ownerOf(0)).to.be.equal(carol.address);

        await pfpStore.connect(bob).createAuction(pfp.address, 1, 10000, (await getBlock()) + 310);
        await pfpStore.setFee(25);
        await pfps.connect(pfpManager).setRoyalty(pfp.address, pfpManager.address, 900);
        await expect(() => pfpStore.connect(dan).bid(pfp.address, 1, 10000)).to.changeTokenBalances(
            mix,
            [dan, pfpStore],
            [-10000, 10000]
        );
        await mine(310);
        await expect(() => pfpStore.claim(pfp.address, 1)).to.changeTokenBalances(
            mix,
            [alice, bob, pfpManager, pfpStore],
            [25, 9075, 900, -10000]
        );

        await expect(() => pfpStore.connect(alice).makeOffer(pfp.address, 2, 3000)).to.changeTokenBalance(
            mix,
            alice,
            -3000
        );
        await pfpStore.setFeeReceiver(deployer.address);
        await pfps.connect(pfpManager).setRoyalty(pfp.address, dan.address, 110);

        await expect(() => pfpStore.connect(bob).acceptOffer(pfp.address, 2, 0)).to.changeTokenBalances(
            mix,
            [deployer, alice, bob, pfpManager, dan, pfpStore],
            [7, 0, 2960, 0, 33, -3000]
        );
    });

    it("should be that if someone bids at auctionExtensionInterval before endBlock, the auciton will be extended by the interval", async () => {
        const { alice, bob, carol, dan, pfp, pfpStore } = await setupTest();

        expect(await pfpStore.auctionExtensionInterval()).to.be.equal(300);
        await expect(pfpStore.connect(alice).setAuctionExtensionInterval(500)).to.be.reverted;

        await pfpStore.setAuctionExtensionInterval(500);
        expect(await pfpStore.auctionExtensionInterval()).to.be.equal(500);

        await mineTo(500);
        await pfp.massMint(bob.address, 2);
        await pfp.connect(bob).setApprovalForAll(pfpStore.address, true);

        const endBlock0 = (await getBlock()) + 100;
        await pfpStore.connect(bob).createAuction(pfp.address, 0, 10000, endBlock0);
        expect((await pfpStore.auctions(pfp.address, 0)).endBlock).to.be.equal(endBlock0);

        await pfpStore.connect(carol).bid(pfp.address, 0, 10000);
        expect((await pfpStore.auctions(pfp.address, 0)).endBlock).to.be.equal(endBlock0 + 500);

        await mine(10);
        await pfpStore.connect(dan).bid(pfp.address, 0, 10001);
        expect((await pfpStore.auctions(pfp.address, 0)).endBlock).to.be.equal(endBlock0 + 500);

        await mineTo(endBlock0 - 1);
        await pfpStore.connect(dan).bid(pfp.address, 0, 10002);
        expect((await pfpStore.auctions(pfp.address, 0)).endBlock).to.be.equal(endBlock0 + 500);

        await pfpStore.connect(dan).bid(pfp.address, 0, 10003);
        expect((await pfpStore.auctions(pfp.address, 0)).endBlock).to.be.equal(endBlock0 + 1000);

        await mineTo(endBlock0 + 1000 - 1);
        await pfpStore.connect(carol).bid(pfp.address, 0, 10004);
        expect((await pfpStore.auctions(pfp.address, 0)).endBlock).to.be.equal(endBlock0 + 1500);

        await mineTo(endBlock0 + 1500);
        await expect(pfpStore.connect(carol).bid(pfp.address, 0, 10005)).to.be.reverted;
    });

    it("should be that unlisted or banned pfp tokens on PFPs contract can't be traded on PFPStore", async () => {
        const { bob, carol, pfp3, pfps, pfpStore } = await setupTest();

        const TestPFP = await ethers.getContractFactory("TestPFP");
        const pfp4 = (await TestPFP.deploy()) as TestPFP;

        expect(await pfps.added(pfp3.address)).to.be.false;
        expect(await pfps.added(pfp4.address)).to.be.false;

        await pfp4.massMint(bob.address, 10);
        await pfp4.connect(bob).setApprovalForAll(pfpStore.address, true);

        await expect(pfpStore.connect(bob).sell([pfp4.address], [0], [1000])).to.be.reverted;
        await expect(pfpStore.connect(bob).createAuction(pfp4.address, 1, 1000, (await getBlock()) + 100)).to.be
            .reverted;
        await expect(pfpStore.connect(carol).makeOffer(pfp4.address, 2, 1000)).to.be.reverted;

        await pfps.addByOwner(pfp4.address, bob.address);
        await pfpStore.connect(bob).sell([pfp4.address], [0], [1000]);
        await pfpStore.connect(bob).createAuction(pfp4.address, 1, 1000, (await getBlock()) + 100);
        await pfpStore.connect(carol).makeOffer(pfp4.address, 2, 1000);
        await pfpStore.connect(carol).makeOffer(pfp4.address, 3, 1000);

        await pfps.ban(pfp4.address);
        await expect(pfpStore.connect(bob).sell([pfp4.address], [4], [1000])).to.be.reverted;
        await expect(pfpStore.connect(bob).createAuction(pfp4.address, 5, 1000, (await getBlock()) + 100)).to.be
            .reverted;
        await expect(pfpStore.connect(carol).makeOffer(pfp4.address, 6, 1000)).to.be.reverted;

        await pfpStore.connect(bob).cancelSale([pfp4.address], [0]);
        await pfpStore.connect(carol).cancelOffer(pfp4.address, 2, 0);

        await pfps.unban(pfp4.address);
        await pfpStore.connect(bob).sell([pfp4.address], [4], [1000]);
        await pfpStore.connect(bob).createAuction(pfp4.address, 5, 1000, (await getBlock()) + 100);
        await pfpStore.connect(carol).makeOffer(pfp4.address, 6, 1000);

        await pfpStore.connect(bob).cancelAuction(pfp4.address, 1);
        await pfpStore.connect(carol).cancelOffer(pfp4.address, 3, 0);

        await pfp3.massMint(bob.address, 10);
        await pfp3.connect(bob).setApprovalForAll(pfpStore.address, true);

        await expect(pfpStore.connect(bob).sell([pfp3.address], [0], [1000])).to.be.reverted;
        await expect(pfpStore.connect(bob).createAuction(pfp3.address, 1, 1000, (await getBlock()) + 100)).to.be
            .reverted;
        await expect(pfpStore.connect(carol).makeOffer(pfp3.address, 2, 1000)).to.be.reverted;

        await pfps.ban(pfp3.address);

        await expect(pfpStore.connect(bob).sell([pfp3.address], [4], [1000])).to.be.reverted;
        await expect(pfpStore.connect(bob).createAuction(pfp3.address, 5, 1000, (await getBlock()) + 100)).to.be
            .reverted;
        await expect(pfpStore.connect(carol).makeOffer(pfp3.address, 6, 1000)).to.be.reverted;
    });

    it("should be that updating PFPs works properly", async () => {
        const { bob, carol, pfp, pfps, pfpManager, pfpStore } = await setupTest();

        const PFPs = await ethers.getContractFactory("PFPs");
        const pfps2 = (await PFPs.deploy()) as PFPs;

        expect(await pfps.added(pfp.address)).to.be.true;
        expect(await pfps2.added(pfp.address)).to.be.false;

        await pfp.massMint(bob.address, 10);
        await pfp.connect(bob).setApprovalForAll(pfpStore.address, true);

        await pfpStore.connect(bob).sell([pfp.address], [0], [1000]);
        await pfpStore.connect(bob).createAuction(pfp.address, 1, 1000, (await getBlock()) + 100);
        await pfpStore.connect(carol).makeOffer(pfp.address, 2, 1000);
        await pfpStore.connect(carol).bid(pfp.address, 1, 1000);

        await pfpStore.setPFPs(pfps2.address);
        await expect(pfpStore.connect(bob).sell([pfp.address], [3], [1000])).to.be.reverted;
        await expect(pfpStore.connect(bob).createAuction(pfp.address, 4, 1000, (await getBlock()) + 100)).to.be
            .reverted;
        await expect(pfpStore.connect(carol).makeOffer(pfp.address, 5, 1000)).to.be.reverted;
        await expect(pfpStore.connect(carol).bid(pfp.address, 1, 1001)).to.be.reverted;

        await pfps2.addByOwner(pfp.address, pfpManager.address);

        await pfpStore.connect(bob).sell([pfp.address], [3], [1000]);
        await pfpStore.connect(bob).createAuction(pfp.address, 4, 1000, (await getBlock()) + 100);
        await pfpStore.connect(carol).makeOffer(pfp.address, 5, 1000);
        await pfpStore.connect(carol).bid(pfp.address, 1, 1001);
    });

    it("should be that anyone having pfp tokens whitelisted can trade them", async () => {
        const { alice, bob, carol, pfp, pfpStore } = await setupTest();

        await pfp.massMint2(alice.address, 0, 3); //0,1,2
        await pfp.massMint2(bob.address, 3, 3); //3,4,5
        await pfp.massMint2(carol.address, 6, 3); //6,7,8

        await pfp.connect(alice).setApprovalForAll(pfpStore.address, true);
        await pfp.connect(bob).setApprovalForAll(pfpStore.address, true);
        await pfp.connect(carol).setApprovalForAll(pfpStore.address, true);

        await pfpStore.connect(alice).sell([pfp.address, pfp.address], [0, 1], [1000, 1001]);
        await pfpStore.connect(alice).createAuction(pfp.address, 2, 1002, (await getBlock()) + 100);

        await pfpStore.connect(bob).sell([pfp.address, pfp.address], [3, 4], [1003, 1004]);
        await pfpStore.connect(bob).createAuction(pfp.address, 5, 1005, (await getBlock()) + 100);

        await pfpStore.connect(carol).sell([pfp.address, pfp.address], [6, 7], [1006, 1007]);
        await pfpStore.connect(carol).createAuction(pfp.address, 8, 1008, (await getBlock()) + 100);
    });

    it("should be that cross trades is prohibited", async () => {
        const { alice, pfp, pfpStore } = await setupTest();

        await pfp.massMint2(alice.address, 0, 10);
        await pfp.connect(alice).setApprovalForAll(pfpStore.address, true);

        await pfpStore.connect(alice).sell([pfp.address, pfp.address, pfp.address], [0, 1, 2], [1000, 1001, 1002]);

        await expect(pfpStore.connect(alice).buy([pfp.address], [0])).to.be.reverted;
        await expect(pfpStore.connect(alice).makeOffer(pfp.address, 3, 100)).to.be.reverted;

        await pfpStore.connect(alice).createAuction(pfp.address, 3, 1000, (await getBlock()) + 100);
        await expect(pfpStore.connect(alice).bid(pfp.address, 3, 2000)).to.be.reverted;

        expect(await pfp.ownerOf(0)).to.be.equal(pfpStore.address);
        await pfpStore.connect(alice).makeOffer(pfp.address, 0, 100);

        await pfpStore.connect(alice).cancelSale([pfp.address], [0]);
        expect(await pfp.ownerOf(0)).to.be.equal(alice.address);

        await expect(pfpStore.connect(alice).acceptOffer(pfp.address, 0, 0)).to.be.reverted;
        await pfpStore.connect(alice).cancelOffer(pfp.address, 0, 0);
    });

    it("should be that an auction with biddings can't be canceled", async () => {
        const { alice, bob, pfp, pfpStore } = await setupTest();

        await pfp.massMint2(alice.address, 0, 10);
        await pfp.connect(alice).setApprovalForAll(pfpStore.address, true);

        const endBlock = (await getBlock()) + 500;

        await pfpStore.connect(alice).createAuction(pfp.address, 0, 1000, endBlock);
        await pfpStore.connect(alice).createAuction(pfp.address, 1, 1000, endBlock);
        await pfpStore.connect(alice).createAuction(pfp.address, 2, 1000, endBlock);

        expect(await pfp.ownerOf(0)).to.be.equal(pfpStore.address);
        expect(await pfp.ownerOf(1)).to.be.equal(pfpStore.address);
        expect(await pfp.ownerOf(2)).to.be.equal(pfpStore.address);

        await pfpStore.connect(alice).cancelAuction(pfp.address, 0);
        expect(await pfp.ownerOf(0)).to.be.equal(alice.address);
        await expect(pfpStore.connect(alice).cancelAuction(pfp.address, 0)).to.be.reverted;

        await pfpStore.connect(bob).bid(pfp.address, 1, 1000);
        await expect(pfpStore.connect(alice).cancelAuction(pfp.address, 1)).to.be.reverted;

        expect((await pfpStore.auctions(pfp.address, 1)).endBlock).to.be.equal(endBlock);
        expect((await pfpStore.auctions(pfp.address, 1)).endBlock).to.be.equal(endBlock);

        await mine(500);
        expect((await pfpStore.auctions(pfp.address, 1)).endBlock).to.be.lt(await getBlock());
        expect((await pfpStore.auctions(pfp.address, 2)).endBlock).to.be.lt(await getBlock());

        await expect(pfpStore.connect(alice).cancelAuction(pfp.address, 1)).to.be.reverted;

        await expect(pfpStore.connect(bob).bid(pfp.address, 1, 1000)).to.be.reverted;
        await pfpStore.connect(alice).cancelAuction(pfp.address, 2);

        expect(await pfp.ownerOf(0)).to.be.equal(alice.address);
        expect(await pfp.ownerOf(1)).to.be.equal(pfpStore.address);
        expect(await pfp.ownerOf(2)).to.be.equal(alice.address);
    });

    it("should be that users can't cancel others' sale/offer/auction", async () => {
        const { alice, bob, carol, pfp, pfpStore } = await setupTest();

        await pfp.massMint2(alice.address, 0, 3); //0,1,2
        await pfp.massMint2(bob.address, 3, 3); //3,4,5
        await pfp.massMint2(carol.address, 6, 3); //6,7,8
        await pfp.connect(alice).setApprovalForAll(pfpStore.address, true);
        await pfp.connect(bob).setApprovalForAll(pfpStore.address, true);
        await pfp.connect(carol).setApprovalForAll(pfpStore.address, true);

        await pfpStore.connect(alice).sell([pfp.address, pfp.address], [0, 1], [1000, 1001]);
        await expect(pfpStore.connect(bob).cancelSale([pfp.address], [0])).to.be.reverted;
        await pfpStore.connect(alice).cancelSale([pfp.address], [0]);

        await pfpStore.connect(bob).createAuction(pfp.address, 3, 1000, 10000);
        await expect(pfpStore.connect(alice).cancelAuction(pfp.address, 3)).to.be.reverted;
        await pfpStore.connect(bob).cancelAuction(pfp.address, 3);

        await pfpStore.connect(carol).makeOffer(pfp.address, 0, 100);
        await expect(pfpStore.connect(bob).cancelOffer(pfp.address, 0, 0)).to.be.reverted;
        await pfpStore.connect(carol).cancelOffer(pfp.address, 0, 0);
    });

    it.only("should be that sell, cancelSale, buy functions work properly with multiple parameters", async () => {
        const { deployer, alice, bob, carol, pfp, pfp2, pfpManager, pfp2Manager, pfps, pfpStore, mix } =
            await setupTest();

        await pfps.connect(pfpManager).setRoyalty(pfp.address, pfpManager.address, 200);
        await pfps.connect(pfp2Manager).setRoyalty(pfp2.address, pfp2Manager.address, 1);

        await pfp.connect(alice).setApprovalForAll(pfpStore.address, true);
        await pfp2.connect(alice).setApprovalForAll(pfpStore.address, true);
        await pfp2.connect(bob).setApprovalForAll(pfpStore.address, true);

        await pfp.massMint2(alice.address, 0, 10);
        await pfp2.massMint2(alice.address, 0, 10);
        await pfp2.massMint2(bob.address, 10, 10);

        expect(await pfp.ownerOf(0)).to.be.equal(alice.address);
        expect(await pfp.ownerOf(1)).to.be.equal(alice.address);
        expect(await pfp.ownerOf(2)).to.be.equal(alice.address);
        expect(await pfp.ownerOf(3)).to.be.equal(alice.address);
        expect(await pfp2.ownerOf(0)).to.be.equal(alice.address);
        expect(await pfp2.ownerOf(1)).to.be.equal(alice.address);
        expect(await pfp2.ownerOf(2)).to.be.equal(alice.address);
        expect(await pfp2.ownerOf(3)).to.be.equal(alice.address);

        await pfpStore
            .connect(alice)
            .sell(
                [pfp.address, pfp.address, pfp.address, pfp.address, pfp2.address, pfp2.address, pfp2.address],
                [0, 1, 2, 3, 3, 2, 1],
                [1000, 1001, 1002, 1003, 100003, 100002, 100001]
            );

        expect(await pfp.ownerOf(0)).to.be.equal(pfpStore.address);
        expect(await pfp.ownerOf(1)).to.be.equal(pfpStore.address);
        expect(await pfp.ownerOf(2)).to.be.equal(pfpStore.address);
        expect(await pfp.ownerOf(3)).to.be.equal(pfpStore.address);
        expect(await pfp2.ownerOf(0)).to.be.equal(alice.address);
        expect(await pfp2.ownerOf(1)).to.be.equal(pfpStore.address);
        expect(await pfp2.ownerOf(2)).to.be.equal(pfpStore.address);
        expect(await pfp2.ownerOf(3)).to.be.equal(pfpStore.address);

        expect(await pfp2.ownerOf(10)).to.be.equal(bob.address);
        expect(await pfp2.ownerOf(11)).to.be.equal(bob.address);

        await pfpStore.connect(bob).sell([pfp2.address, pfp2.address], [10, 11], [100010, 100011]);

        expect(await pfp2.ownerOf(10)).to.be.equal(pfpStore.address);
        expect(await pfp2.ownerOf(11)).to.be.equal(pfpStore.address);

        await expect(pfpStore.connect(alice).buy([pfp2.address, pfp2.address], [10, 1])).to.be.reverted;
        await expect(pfpStore.connect(alice).cancelSale([pfp2.address, pfp2.address], [10, 1])).to.be.reverted;

        const priceAll = 1002 + 100003 + 100010;
        const toAlice =
            1002 +
            100003 -
            (Math.floor((1002 * 200) / 10000) +
                Math.floor((100003 * 1) / 10000) +
                Math.floor((1002 * 25) / 10000) +
                Math.floor((100003 * 25) / 10000));
        const toBob = 100010 - (Math.floor((100010 * 1) / 10000) + Math.floor((100010 * 25) / 10000));

        const pfpManagerFee = Math.floor((1002 * 200) / 10000);
        const pfp2ManagerFee = Math.floor((100003 * 1) / 10000) + Math.floor((100010 * 1) / 10000);
        const deployerFee =
            Math.floor((1002 * 25) / 10000) + Math.floor((100003 * 25) / 10000) + Math.floor((100010 * 25) / 10000);

        expect(priceAll).to.be.equal(toAlice + toBob + pfpManagerFee + pfp2ManagerFee + deployerFee);

        await expect(() =>
            pfpStore.connect(carol).buy([pfp.address, pfp2.address, pfp2.address], [2, 3, 10])
        ).to.changeTokenBalances(
            mix,
            [carol, alice, bob, deployer, pfpManager, pfp2Manager, pfpStore],
            [-priceAll, toAlice, toBob, deployerFee, pfpManagerFee, pfp2ManagerFee, 0]
        );

        expect(await pfp.ownerOf(0)).to.be.equal(pfpStore.address);
        expect(await pfp.ownerOf(1)).to.be.equal(pfpStore.address);
        expect(await pfp.ownerOf(3)).to.be.equal(pfpStore.address);
        expect(await pfp2.ownerOf(1)).to.be.equal(pfpStore.address);
        expect(await pfp2.ownerOf(2)).to.be.equal(pfpStore.address);

        await pfpStore.connect(alice).cancelSale([pfp.address, pfp.address, pfp2.address, pfp2.address], [3, 0, 1 ,2]);

        expect(await pfp.ownerOf(0)).to.be.equal(alice.address);
        expect(await pfp.ownerOf(1)).to.be.equal(pfpStore.address);
        expect(await pfp.ownerOf(3)).to.be.equal(alice.address);
        expect(await pfp2.ownerOf(1)).to.be.equal(alice.address);
        expect(await pfp2.ownerOf(2)).to.be.equal(alice.address);
    });

});
