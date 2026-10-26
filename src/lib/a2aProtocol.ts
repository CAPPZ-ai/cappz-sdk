// A2A Protocol: Agent-to-Agent Communication Protocol

import CryptoJS from 'crypto-js';

export type A2AMessageType =
  | 'SYNC_REQUEST'
  | 'SYNC_RESPONSE'
  | 'CHAINLET_BATCH'
  | 'VIEW_QUERY'
  | 'VIEW_RESULT'
  | 'HEARTBEAT'
  | 'HEARTBEAT_ACK'
  | 'TRUST_UPDATE'
  | 'BLOCK_REQUEST'
  | 'BLOCK_RESPONSE'
  | 'GAP_HEAL_REQUEST'
  | 'GAP_HEAL_RESPONSE';

export interface A2AMessageHeader {
  version: string;
  messageId: string;
  timestamp: string;
  fromAgent: string;
  toAgent: string;
  messageType: A2AMessageType;
  correlationId?: string;
  ttl: number; // Time to live in seconds
}

export interface A2AMessageBody {
  payload: any;
  signature: string;
  compressed?: boolean;
}

export interface A2AMessage {
  header: A2AMessageHeader;
  body: A2AMessageBody;
}

export interface A2ATrustInfo {
  agentId: string;
  trustScore: number;
  lastInteraction: Date;
  successfulExchanges: number;
  failedExchanges: number;
}

export interface A2ARouteInfo {
  fromAgent: string;
  toAgent: string;
  hops: string[];
  latencyMs: number;
  lastUsed: Date;
}

export class A2AProtocol {
  private static instance: A2AProtocol;
  private readonly VERSION = '1.0.0';
  private readonly DEFAULT_TTL = 300; // 5 minutes
  private trustRegistry: Map<string, A2ATrustInfo> = new Map();
  private routeCache: Map<string, A2ARouteInfo> = new Map();

  private constructor() {}

  static getInstance(): A2AProtocol {
    if (!A2AProtocol.instance) {
      A2AProtocol.instance = new A2AProtocol();
    }
    return A2AProtocol.instance;
  }

  /**
   * Create A2A message
   */
  createMessage(
    fromAgent: string,
    toAgent: string,
    messageType: A2AMessageType,
    payload: any,
    signingKey: string,
    options: {
      correlationId?: string;
      ttl?: number;
      compress?: boolean;
    } = {}
  ): A2AMessage {
    const messageId = this.generateMessageId();
    
    let processedPayload = payload;
    if (options.compress) {
      processedPayload = this.compressPayload(payload);
    }

    const signature = this.signPayload(processedPayload, signingKey);

    return {
      header: {
        version: this.VERSION,
        messageId,
        timestamp: new Date().toISOString(),
        fromAgent,
        toAgent,
        messageType,
        correlationId: options.correlationId,
        ttl: options.ttl || this.DEFAULT_TTL
      },
      body: {
        payload: processedPayload,
        signature,
        compressed: options.compress
      }
    };
  }

  /**
   * Validate incoming message
   */
  validateMessage(message: A2AMessage, expectedAgent?: string): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check version compatibility
    if (!message.header.version.startsWith('1.')) {
      errors.push(`Unsupported protocol version: ${message.header.version}`);
    }

    // Check TTL
    const messageAge = Date.now() - new Date(message.header.timestamp).getTime();
    if (messageAge > message.header.ttl * 1000) {
      errors.push('Message has expired');
    }

    // Check recipient
    if (expectedAgent && message.header.toAgent !== expectedAgent) {
      errors.push(`Message intended for different agent: ${message.header.toAgent}`);
    }

    // Validate signature (simplified - in production, verify against sender's public key)
    if (!message.body.signature) {
      errors.push('Missing message signature');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Create sync request message
   */
  createSyncRequest(
    fromAgent: string,
    toAgent: string,
    signingKey: string,
    data: {
      chainletId: string;
      fromBlock?: number;
      toBlock?: number;
      includeTransactions?: boolean;
    }
  ): A2AMessage {
    return this.createMessage(
      fromAgent,
      toAgent,
      'SYNC_REQUEST',
      data,
      signingKey
    );
  }

  /**
   * Create sync response message
   */
  createSyncResponse(
    fromAgent: string,
    toAgent: string,
    signingKey: string,
    correlationId: string,
    data: {
      chainletId: string;
      blocks: any[];
      hasMore: boolean;
      nextBlock?: number;
    }
  ): A2AMessage {
    return this.createMessage(
      fromAgent,
      toAgent,
      'SYNC_RESPONSE',
      data,
      signingKey,
      { correlationId }
    );
  }

  /**
   * Create chainlet batch message
   */
  createChainletBatch(
    fromAgent: string,
    toAgent: string,
    signingKey: string,
    blocks: any[]
  ): A2AMessage {
    return this.createMessage(
      fromAgent,
      toAgent,
      'CHAINLET_BATCH',
      { blocks, count: blocks.length },
      signingKey,
      { compress: blocks.length > 10 }
    );
  }

  /**
   * Create view query message
   */
  createViewQuery(
    fromAgent: string,
    toAgent: string,
    signingKey: string,
    data: {
      viewName: string;
      filters?: Record<string, any>;
      limit?: number;
    }
  ): A2AMessage {
    return this.createMessage(
      fromAgent,
      toAgent,
      'VIEW_QUERY',
      data,
      signingKey
    );
  }

  /**
   * Create heartbeat message
   */
  createHeartbeat(
    fromAgent: string,
    toAgent: string,
    signingKey: string
  ): A2AMessage {
    return this.createMessage(
      fromAgent,
      toAgent,
      'HEARTBEAT',
      { timestamp: Date.now() },
      signingKey,
      { ttl: 30 }
    );
  }

  /**
   * Create block request message
   */
  createBlockRequest(
    fromAgent: string,
    toAgent: string,
    signingKey: string,
    data: {
      chainletId: string;
      blockNumbers: number[];
      expectedHDAddresses?: string[];
    }
  ): A2AMessage {
    return this.createMessage(
      fromAgent,
      toAgent,
      'BLOCK_REQUEST',
      data,
      signingKey
    );
  }

  /**
   * Create gap heal request
   */
  createGapHealRequest(
    fromAgent: string,
    toAgent: string,
    signingKey: string,
    data: {
      chainletId: string;
      gapRanges: Array<{ start: number; end: number }>;
    }
  ): A2AMessage {
    return this.createMessage(
      fromAgent,
      toAgent,
      'GAP_HEAL_REQUEST',
      data,
      signingKey
    );
  }

  /**
   * Update trust score for an agent
   */
  updateTrust(agentId: string, success: boolean): void {
    let trust = this.trustRegistry.get(agentId);
    
    if (!trust) {
      trust = {
        agentId,
        trustScore: 50,
        lastInteraction: new Date(),
        successfulExchanges: 0,
        failedExchanges: 0
      };
    }

    trust.lastInteraction = new Date();
    
    if (success) {
      trust.successfulExchanges++;
      trust.trustScore = Math.min(100, trust.trustScore + 1);
    } else {
      trust.failedExchanges++;
      trust.trustScore = Math.max(0, trust.trustScore - 5);
    }

    this.trustRegistry.set(agentId, trust);
  }

  /**
   * Get trust info for an agent
   */
  getTrust(agentId: string): A2ATrustInfo | null {
    return this.trustRegistry.get(agentId) || null;
  }

  /**
   * Cache route information
   */
  cacheRoute(fromAgent: string, toAgent: string, hops: string[], latencyMs: number): void {
    const key = `${fromAgent}->${toAgent}`;
    this.routeCache.set(key, {
      fromAgent,
      toAgent,
      hops,
      latencyMs,
      lastUsed: new Date()
    });
  }

  /**
   * Get cached route
   */
  getRoute(fromAgent: string, toAgent: string): A2ARouteInfo | null {
    const key = `${fromAgent}->${toAgent}`;
    return this.routeCache.get(key) || null;
  }

  /**
   * Generate unique message ID
   */
  private generateMessageId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `msg_${timestamp}_${random}`;
  }

  /**
   * Sign payload
   */
  private signPayload(payload: any, signingKey: string): string {
    const message = JSON.stringify(payload);
    return CryptoJS.HmacSHA256(message, signingKey).toString();
  }

  /**
   * Verify signature
   */
  verifySignature(payload: any, signature: string, verifyingKey: string): boolean {
    const expectedSignature = this.signPayload(payload, verifyingKey);
    return expectedSignature === signature;
  }

  /**
   * Compress payload (simplified - in production use actual compression)
   */
  private compressPayload(payload: any): string {
    return btoa(JSON.stringify(payload));
  }

  /**
   * Decompress payload
   */
  decompressPayload(compressed: string): any {
    return JSON.parse(atob(compressed));
  }

  /**
   * Extract message type from raw message
   */
  extractMessageType(message: A2AMessage): A2AMessageType {
    return message.header.messageType;
  }

  /**
   * Check if message is response to another
   */
  isResponseTo(response: A2AMessage, request: A2AMessage): boolean {
    return response.header.correlationId === request.header.messageId;
  }

  /**
   * Get protocol version
   */
  getVersion(): string {
    return this.VERSION;
  }

  /**
   * Clear caches
   */
  clearCaches(): void {
    this.routeCache.clear();
  }
}

export const a2aProtocol = A2AProtocol.getInstance();
