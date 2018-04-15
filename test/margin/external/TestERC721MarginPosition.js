/*global web3, artifacts, contract, describe, it, before, beforeEach,*/

const Web3 = require('web3');
const BigNumber = require('bignumber.js');
const web3Instance = new Web3(web3.currentProvider);
const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-bignumber')());

const ERC721MarginPosition = artifacts.require("ERC721MarginPosition");
const Margin = artifacts.require("Margin");
const ProxyContract = artifacts.require("Proxy");
const BaseToken = artifacts.require("TokenB");

const { BYTES32 } = require('../../helpers/Constants');
const { expectThrow } = require('../../helpers/ExpectHelper');
const {
  doOpenPosition,
  issueTokensAndSetAllowancesForClose,
  callClosePosition,
  getMaxInterestFee,
  callClosePositionDirectly
} = require('../../helpers/MarginHelper');
const {
  createSignedSellOrder
} = require('../../helpers/0xHelper');

function uint256(positionId) {
  return new BigNumber(web3Instance.utils.toBN(positionId));
}

contract('ERC721MarginPosition', function(accounts) {
  let dydxMargin, erc721Contract, baseToken;
  let salt = 1111;

  before('retrieve deployed contracts', async () => {
    [
      dydxMargin,
      erc721Contract,
      baseToken
    ] = await Promise.all([
      Margin.deployed(),
      ERC721MarginPosition.deployed(),
      BaseToken.deployed()
    ]);
  });

  describe('Constructor', () => {
    it('sets constants correctly', async () => {
      const contract = await ERC721MarginPosition.new(Margin.address);
      const dydxMarginAddress = await contract.MARGIN.call();
      expect(dydxMarginAddress).to.equal(Margin.address);
    });
  });

  describe('#receivePositionOwnership', () => {
    it('fails for arbitrary caller', async () => {
      await expectThrow(
        erc721Contract.receivePositionOwnership(accounts[0], BYTES32.BAD_ID));
    });

    it('succeeds for new position', async () => {
      const OpenTx = await doOpenPosition(accounts, salt++, ERC721MarginPosition.address);
      const owner = await erc721Contract.ownerOf.call(uint256(OpenTx.id));
      expect(owner).to.equal(accounts[0]);
    });

    it('succeeds for half-closed position', async () => {
      const OpenTx = await doOpenPosition(accounts, salt++);

      // close half the position
      const sellOrder = await createSignedSellOrder(accounts, salt++);
      await issueTokensAndSetAllowancesForClose(OpenTx, sellOrder);
      await callClosePosition(
        dydxMargin,
        OpenTx,
        sellOrder,
        OpenTx.principal.div(2));

      // transfer position to ERC20ShortCreator
      await dydxMargin.transferPosition(OpenTx.id, erc721Contract.address);
      const owner = await erc721Contract.ownerOf.call(uint256(OpenTx.id));
      expect(owner).to.equal(accounts[0]);
    });
  });

  describe('#getPositionDeedHolder', () => {
    it('fails for bad positionId', async () => {
      await expectThrow(
        erc721Contract.getPositionDeedHolder(BYTES32.BAD_ID));
    });

    it('succeeds for owned position', async () => {
      const OpenTx = await doOpenPosition(accounts, salt++, ERC721MarginPosition.address);
      const deedHolder = await erc721Contract.getPositionDeedHolder.call(OpenTx.id);
      expect(deedHolder).to.equal(accounts[0]);
    });
  });

  describe('#approveCloser', () => {
    const sender = accounts[6];
    const helper = accounts[7];

    it('succeeds in approving', async () => {
      await erc721Contract.approveCloser(helper, true, { from: sender });
      const approved = await erc721Contract.approvedClosers.call(sender, helper);
      expect(approved).to.be.true;
    });

    it('succeeds in revoking approval', async () => {
      await erc721Contract.approveCloser(helper, true, { from: sender });
      await erc721Contract.approveCloser(helper, false, { from: sender });
      const approved = await erc721Contract.approvedClosers.call(sender, helper);
      expect(approved).to.be.false;
    });

    it('succeeds when true => true', async () => {
      await erc721Contract.approveCloser(helper, true, { from: sender });
      await erc721Contract.approveCloser(helper, true, { from: sender });
      const approved = await erc721Contract.approvedClosers.call(sender, helper);
      expect(approved).to.be.true;
    });

    it('succeeds when false => false', async () => {
      await erc721Contract.approveCloser(helper, true, { from: sender });
      await erc721Contract.approveCloser(helper, false, { from: sender });
      await erc721Contract.approveCloser(helper, false, { from: sender });
      const approved = await erc721Contract.approvedClosers.call(sender, helper);
      expect(approved).to.be.false;
    });

    it('throws when address approves itself', async () => {
      await expectThrow(
        erc721Contract.approveCloser(helper, true, { from: helper }));
    });
  });

  describe('#approveRecipient', () => {
    const sender = accounts[6];
    const recipient = accounts[7];

    it('succeeds in approving', async () => {
      await erc721Contract.approveRecipient(recipient, true, { from: sender });
      const approved = await erc721Contract.approvedRecipients.call(sender, recipient);
      expect(approved).to.be.true;
    });

    it('succeeds in revoking approval', async () => {
      await erc721Contract.approveRecipient(recipient, true, { from: sender });
      await erc721Contract.approveRecipient(recipient, false, { from: sender });
      const approved = await erc721Contract.approvedRecipients.call(sender, recipient);
      expect(approved).to.be.false;
    });

    it('succeeds when true => true', async () => {
      await erc721Contract.approveRecipient(recipient, true, { from: sender });
      await erc721Contract.approveRecipient(recipient, true, { from: sender });
      const approved = await erc721Contract.approvedRecipients.call(sender, recipient);
      expect(approved).to.be.true;
    });

    it('succeeds when false => false', async () => {
      await erc721Contract.approveRecipient(recipient, true, { from: sender });
      await erc721Contract.approveRecipient(recipient, false, { from: sender });
      await erc721Contract.approveRecipient(recipient, false, { from: sender });
      const approved = await erc721Contract.approvedRecipients.call(sender, recipient);
      expect(approved).to.be.false;
    });
  });

  describe('#transferPosition', () => {
    const receiver = accounts[9];
    const trader = accounts[0];
    let OpenTx;

    beforeEach('sets up position', async () => {
      OpenTx = await doOpenPosition(accounts, salt++, ERC721MarginPosition.address);
      const owner = await erc721Contract.ownerOf.call(uint256(OpenTx.id));
      expect(owner).to.equal(trader);
    });

    it('succeeds when called by ownerOf', async () => {
      await erc721Contract.transferPosition(OpenTx.id, receiver, { from: trader });
      await expectThrow(erc721Contract.ownerOf.call(uint256(OpenTx.id)));
      const newOwner = await dydxMargin.getPositionOwner.call(OpenTx.id);
      expect(newOwner).to.equal(receiver);
    });

    it('fails for a non-owner', async () => {
      await expectThrow(
        erc721Contract.transferPosition(OpenTx.id, receiver, { from: accounts[2] }));
    });

    it('fails for a non-existant position', async () => {
      await expectThrow(
        erc721Contract.transferPosition(BYTES32.BAD_ID, receiver, { from: trader }));
    });
  });

  describe('#closeOnBehalfOf', () => {
    let OpenTx;
    const approvedCloser = accounts[6];
    const approvedRecipient = accounts[7];
    const unapprovedAcct = accounts[9];

    async function initBase(account) {
      const maxInterest = await getMaxInterestFee(OpenTx);
      const amount = OpenTx.principal.plus(maxInterest);
      await baseToken.issueTo(account, amount);
      await baseToken.approve(ProxyContract.address, amount, { from: account });
    }

    beforeEach('sets up position', async () => {
      OpenTx = await doOpenPosition(accounts, salt++, ERC721MarginPosition.address);
      await erc721Contract.approveCloser(approvedCloser, true, { from: OpenTx.trader });
      await erc721Contract.approveRecipient(approvedRecipient, true, { from: OpenTx.trader });
    });

    it('succeeds for owner', async () => {
      await initBase(OpenTx.trader);
      await callClosePositionDirectly(
        dydxMargin,
        OpenTx,
        OpenTx.principal,
        OpenTx.trader,
        unapprovedAcct
      );
    });

    it('succeeds for approved recipients', async () => {
      await initBase(unapprovedAcct);
      await callClosePositionDirectly(
        dydxMargin,
        OpenTx,
        OpenTx.principal,
        unapprovedAcct,
        approvedRecipient
      );
    });

    it('succeeds for approved closers', async () => {
      await initBase(approvedCloser);
      await callClosePositionDirectly(
        dydxMargin,
        OpenTx,
        OpenTx.principal,
        approvedCloser,
        unapprovedAcct
      );
    });

    it('fails for non-approved recipients/closers', async () => {
      await initBase(unapprovedAcct);
      await expectThrow(callClosePositionDirectly(
        dydxMargin,
        OpenTx,
        OpenTx.principal,
        unapprovedAcct,
        unapprovedAcct
      ));
    });
  });
});
