import { Client, Wallet, xrpToDrops, dropsToXrp } from 'xrpl';
import type { ChainletBlock, Chainlet } from './chainletTypes';
import CryptoJS from 'crypto-js';

/**
 * XRPLChainletAnchor
 * Anchors chainlet blocks and dependencies on-chain using XRPL
 */
export class XRPLChainletAnchor {
  private static instance: XRPLChainletAnchor;
  private client: Client;
  private wallet: Wallet | null = null;

  private constructor() {
    this.client = new Client('wss://s.altnet.rippletest.net:51233');
  }

  static getInstance(): XRPLChainletAnchor {
    if (!XRPLChainletAnchor.instance) {
      XRPLChainletAnchor.instance = new XRPLChainletAnchor();
    }
    return XRPLChainletAnchor.instance;
  }

  /**
   * Initialize XRPL connection.
   * Accepts either an existing xrpl.Wallet, a raw seed string, or nothing
   * (auto-funds a throwaway testnet wallet).
   */
  async initialize(signerOrSeed?: string | Wallet) {
    if (!this.client.isConnected()) {
      await this.client.connect();
    }

    if (signerOrSeed instanceof Wallet) {
      this.wallet = signerOrSeed;
    } else if (typeof signerOrSeed === 'string' && signerOrSeed.length > 0) {
      this.wallet = Wallet.fromSeed(signerOrSeed);
    } else {
      // Generate test wallet for development
      const fundResult = await this.client.fundWallet();
      this.wallet = fundResult.wallet;
    }
  }

  /** True if a signer is available for anchoring. */
  hasSigner(): boolean {
    return this.wallet !== null;
  }

  /**
   * Anchor a batch of chainlet block hashes with a Merkle root.
   * Used by the ChainletOutbox drain when AnchorStrategy='batch'.
   * Emits a 0-drop self-Payment carrying the batch metadata as an XRPL memo.
   */
  async anchorBatch(input: {
    merkleRoot: string;
    blockHashes: string[];
    batchSize: number;
    notarizedAt: string | number;
  }): Promise<{ txHash: string; ledgerIndex: number }> {
    if (!this.wallet) {
      throw new Error('XRPL wallet not initialized');
    }
    const payload = {
      type: 'cappz/chainlet-batch/v1',
      merkleRoot: input.merkleRoot,
      blockHashes: input.blockHashes,
      batchSize: input.batchSize,
      notarizedAt: typeof input.notarizedAt === 'number'
        ? new Date(input.notarizedAt).toISOString()
        : input.notarizedAt,
    };
    const memoHex = Buffer.from(JSON.stringify(payload), 'utf-8').toString('hex').toUpperCase();
    const prepared = await this.client.autofill({
      TransactionType: 'Payment',
      Account: this.wallet.address,
      Destination: this.wallet.address,
      Amount: '1',
      Memos: [{
        Memo: {
          MemoType: Buffer.from('cappz-chainlet-batch', 'utf-8').toString('hex').toUpperCase(),
          MemoData: memoHex,
        },
      }],
    });
    const signed = this.wallet.sign(prepared);
    const result = await this.client.submitAndWait(signed.tx_blob);
    if (result.result.meta && typeof result.result.meta === 'object') {
      return {
        txHash: signed.hash,
        ledgerIndex: result.result.ledger_index || 0,
      };
    }
    throw new Error('Failed to anchor batch on XRPL');
  }


  /**
   * Anchor a chainlet block on XRPL
   */
  async anchorBlock(
    chainlet: Chainlet,
    block: ChainletBlock
  ): Promise<{
    txHash: string;
    ledgerIndex: number;
  }> {
    if (!this.wallet) {
      throw new Error('XRPL wallet not initialized');
    }

    // Create compact block summary for on-chain storage
    const blockSummary = {
      chainletId: chainlet.id,
      blockNumber: block.blockNumber,
      merkleRoot: block.merkleRoot,
      hdAddress: block.hdAddress,
      txCount: block.transactionCount,
      timestamp: block.timestamp.toISOString(),
      deps: block.dependencyChain || [],
    };

    // Convert to hex memo
    const memoData = JSON.stringify(blockSummary);
    const memoHex = Buffer.from(memoData).toString('hex').toUpperCase();

    // Create payment transaction with memo
    const prepared = await this.client.autofill({
      TransactionType: 'Payment',
      Account: this.wallet.address,
      Destination: block.hdAddress || this.wallet.address,
      Amount: '1', // 1 drop = minimal amount
      Memos: [
        {
          Memo: {
            MemoType: Buffer.from('chainlet-block', 'utf-8').toString('hex').toUpperCase(),
            MemoData: memoHex,
          },
        },
      ],
    });

    const signed = this.wallet.sign(prepared);
    const result = await this.client.submitAndWait(signed.tx_blob);

    if (result.result.meta && typeof result.result.meta === 'object') {
      return {
        txHash: signed.hash,
        ledgerIndex: result.result.ledger_index || 0,
      };
    }

    throw new Error('Failed to anchor block on XRPL');
  }

  /**
   * Anchor dependency relationship on XRPL
   */
  async anchorDependency(
    parentChainletId: string,
    childChainletId: string,
    dependencyType: string
  ): Promise<{
    txHash: string;
    ledgerIndex: number;
  }> {
    if (!this.wallet) {
      throw new Error('XRPL wallet not initialized');
    }

    const dependencyData = {
      type: 'chainlet-dependency',
      parent: parentChainletId,
      child: childChainletId,
      depType: dependencyType,
      timestamp: new Date().toISOString(),
    };

    const memoData = JSON.stringify(dependencyData);
    const memoHex = Buffer.from(memoData).toString('hex').toUpperCase();

    const prepared = await this.client.autofill({
      TransactionType: 'AccountSet',
      Account: this.wallet.address,
      Memos: [
        {
          Memo: {
            MemoType: Buffer.from('chainlet-dependency', 'utf-8').toString('hex').toUpperCase(),
            MemoData: memoHex,
          },
        },
      ],
    });

    const signed = this.wallet.sign(prepared);
    const result = await this.client.submitAndWait(signed.tx_blob);

    if (result.result.meta && typeof result.result.meta === 'object') {
      return {
        txHash: signed.hash,
        ledgerIndex: result.result.ledger_index || 0,
      };
    }

    throw new Error('Failed to anchor dependency on XRPL');
  }

  /**
   * Verify block anchor on XRPL
   */
  async verifyBlockAnchor(
    txHash: string
  ): Promise<{
    isValid: boolean;
    blockData?: any;
  }> {
    try {
      const tx: any = await this.client.request({
        command: 'tx',
        transaction: txHash,
      });

      const txResult = tx.result;
      if (!txResult || typeof txResult !== 'object') {
        return { isValid: false };
      }

      const memos = (txResult as any).Memos;
      if (!memos || !Array.isArray(memos) || memos.length === 0) {
        return { isValid: false };
      }

      const memo = memos[0].Memo;
      if (!memo || !memo.MemoData) {
        return { isValid: false };
      }

      const memoData = Buffer.from(memo.MemoData, 'hex').toString('utf-8');
      const blockData = JSON.parse(memoData);

      return {
        isValid: true,
        blockData,
      };
    } catch (error) {
      console.error('Error verifying block anchor:', error);
      return { isValid: false };
    }
  }

  /**
   * Query chainlet blocks from XRPL by chainlet ID
   */
  async queryChainletBlocks(chainletId: string): Promise<any[]> {
    if (!this.wallet) {
      throw new Error('XRPL wallet not initialized');
    }

    // Get account transactions
    const response: any = await this.client.request({
      command: 'account_tx',
      account: this.wallet.address,
      limit: 100,
    });

    const blocks: any[] = [];

    const transactions = response.result?.transactions || [];
    for (const txWrapper of transactions) {
      const tx = txWrapper.tx;
      if (tx && typeof tx === 'object') {
        const memos = (tx as any).Memos;
        if (memos && Array.isArray(memos)) {
          for (const memoWrapper of memos) {
            const memo = memoWrapper.Memo;
            if (memo && memo.MemoData) {
              try {
                const memoData = Buffer.from(memo.MemoData, 'hex').toString('utf-8');
                const data = JSON.parse(memoData);
                
                if (data.chainletId === chainletId) {
                  blocks.push({
                    ...data,
                    txHash: (tx as any).hash,
                    ledgerIndex: (tx as any).ledger_index,
                  });
                }
              } catch (e) {
                // Skip invalid memos
              }
            }
          }
        }
      }
    }

    return blocks.sort((a, b) => a.blockNumber - b.blockNumber);
  }

  /**
   * Close XRPL connection
   */
  async disconnect() {
    if (this.client.isConnected()) {
      await this.client.disconnect();
    }
  }
}

export const xrplChainletAnchor = XRPLChainletAnchor.getInstance();
