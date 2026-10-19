import type { PluginContract, PluginContractResult } from "@paybox-sh/sdk";

export const JUPITER_PERPS_PLUGIN_CONTRACT: PluginContract = {
  id: "jupiter-perps",
  name: "Jupiter Perpetuals Copilot",
  description:
    "Non-custodial leveraged perpetual futures trading, live oracle pricing, funding rate intelligence, and liquidation risk management on Solana via PayBox credential vault.",
  tools: [
    {
      id: "jup_perps_get_markets",
      name: "Get Tradable Markets",
      description:
        "Fetch tradable markets on Jupiter Perpetuals (SOL-PERP, BTC-PERP, ETH-PERP) with current mark prices, max leverage, and borrow/funding rates.",
      input_schema: {
        type: "object",
        properties: {},
      },
      output_schema: {
        type: "object",
        properties: {
          markets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                symbol: { type: "string" },
                name: { type: "string" },
                currentPrice: { type: "string" },
                rawPriceUsd: { type: "number" },
                maxLeverage: { type: "string" },
                openFee: { type: "string" },
                closeFee: { type: "string" },
                hourlyBorrowRate: { type: "string" },
              },
            },
          },
        },
      },
      annotations: {
        read_only: true,
        category: "market-data",
      },
    },
    {
      id: "jup_perps_get_quote",
      name: "Get Leverage Quote & Risk Analysis",
      description:
        "Calculate live parameters for opening a leverage position on Jupiter Perpetuals using on-chain Pyth oracles. Computes fees, exact liquidation price, margin requirements, distance to liquidation, and whether PayBox will require user passkey approval.",
      input_schema: {
        type: "object",
        properties: {
          market: {
            type: "string",
            enum: ["SOL-PERP", "BTC-PERP", "ETH-PERP"],
            description: "Market pair to trade",
          },
          side: {
            type: "string",
            enum: ["long", "short"],
            description: "Trade direction: long or short",
          },
          collateralUsd: {
            type: "number",
            description: "Amount of margin / collateral in USD (e.g. 50)",
          },
          leverage: {
            type: "number",
            description: "Leverage multiplier (e.g. 2, 3, 5, 10)",
          },
        },
        required: ["market", "side", "collateralUsd", "leverage"],
      },
      output_schema: {
        type: "object",
        properties: {
          market: { type: "string" },
          side: { type: "string" },
          markPrice: { type: "string" },
          collateral: { type: "string" },
          leverage: { type: "string" },
          totalPositionSize: { type: "string" },
          estimatedOpenFee: { type: "string" },
          estimatedCloseFee: { type: "string" },
          liquidationPrice: { type: "string" },
          distanceToLiquidation: { type: "string" },
          riskLevel: { type: "string" },
          payboxApprovalMode: { type: "string" },
          summary: { type: "string" },
        },
      },
      annotations: {
        read_only: true,
        category: "risk-analysis",
      },
    },
    {
      id: "jup_perps_get_positions",
      name: "Get Open Positions",
      description:
        "Retrieve all active open perpetual positions for a Solana wallet, including entry price, mark price, leverage, unrealized PnL, and liquidation distance.",
      input_schema: {
        type: "object",
        properties: {
          walletAddress: {
            type: "string",
            description:
              "Optional Solana base58 wallet address. Defaults to vaulted PayBox wallet.",
          },
        },
      },
      output_schema: {
        type: "object",
        properties: {
          walletAddress: { type: "string" },
          activePositionsCount: { type: "number" },
          positions: { type: "array" },
        },
      },
      annotations: {
        read_only: true,
        category: "portfolio",
      },
    },
    {
      id: "jup_perps_open_position",
      name: "Open Leverage Position via PayBox",
      description:
        "Constructs and executes an on-chain Jupiter Perps trade using PayBox non-custodial wallet signing. Low-risk trades execute autonomously; high-leverage trades pause for passkey approval.",
      input_schema: {
        type: "object",
        properties: {
          market: {
            type: "string",
            enum: ["SOL-PERP", "BTC-PERP", "ETH-PERP"],
            description: "Market to open position on",
          },
          side: {
            type: "string",
            enum: ["long", "short"],
            description: "Direction: long or short",
          },
          collateralUsd: {
            type: "number",
            description: "Collateral in USD",
          },
          leverage: {
            type: "number",
            description: "Leverage multiplier (e.g. 2, 3, 5)",
          },
          collateralToken: {
            type: "string",
            enum: ["USDC", "SOL"],
            description: "Token to use as collateral (default USDC for shorts, USDC/SOL for longs)",
          },
          walletAddress: {
            type: "string",
            description: "Optional Solana wallet address",
          },
          credentialId: {
            type: "string",
            description: "Optional PayBox wallet credential ID",
          },
          slippageBps: {
            type: "number",
            description: "Slippage tolerance in basis points (default 50 = 0.5%)",
          },
        },
        required: ["market", "side", "collateralUsd", "leverage"],
      },
      output_schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          tradeDetails: { type: "object" },
          onChainRpcVerification: { type: "object" },
          payboxMcpCall: { type: "object" },
          agentNextStep: { type: "string" },
        },
      },
      annotations: {
        read_only: false,
        category: "execution",
        requires_signing: true,
      },
    },
    {
      id: "jup_perps_close_position",
      name: "Close Position via PayBox",
      description:
        "Constructs and signs a transaction to close or decrease an existing Jupiter Perps position via PayBox.",
      input_schema: {
        type: "object",
        properties: {
          positionPubkey: {
            type: "string",
            description: "Base58 public key of the Position PDA to close",
          },
          walletAddress: {
            type: "string",
            description: "Optional Solana wallet address",
          },
          credentialId: {
            type: "string",
            description: "Optional PayBox wallet credential ID",
          },
          desiredReceiveToken: {
            type: "string",
            enum: ["USDC", "SOL"],
            description: "Token to receive back upon closing",
          },
        },
        required: ["positionPubkey"],
      },
      output_schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          closedPosition: { type: "object" },
          payboxMcpCall: { type: "object" },
          agentNextStep: { type: "string" },
        },
      },
      annotations: {
        read_only: false,
        category: "execution",
        requires_signing: true,
      },
    },
    {
      id: "jup_perps_simulate_onchain_tx",
      name: "Simulate Transaction On-Chain",
      description:
        "Sends any compiled base64 Solana VersionedTransaction to the live Solana Mainnet RPC node for runtime simulation. Returns compute units consumed, on-chain program logs, and validation errors.",
      input_schema: {
        type: "object",
        properties: {
          transactionBase64: {
            type: "string",
            description: "Base64 encoded Solana VersionedTransaction (v0)",
          },
        },
        required: ["transactionBase64"],
      },
      output_schema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          unitsConsumed: { type: "number" },
          err: { type: "any" },
          logs: { type: "array" },
        },
      },
      annotations: {
        read_only: true,
        category: "validation",
      },
    },
  ],
};

export const JUPITER_PERPS_CONTRACT_RESULT: PluginContractResult = {
  contract_uri: "paybox://plugins/jupiter-perps",
  contract: JUPITER_PERPS_PLUGIN_CONTRACT,
};

export const PAYBOX_MARKETPLACE_MANIFEST = {
  $schema: "https://developer.paybox.sh/schemas/plugin-manifest.v1.json",
  id: "jupiter-perps",
  name: "Jupiter Perpetuals Copilot",
  version: "1.0.0",
  description:
    "Non-custodial leveraged perpetual trading, oracle pricing, and liquidation risk management on Solana via PayBox credential vault.",
  contract_uri: "paybox://plugins/jupiter-perps",
  category: "consumer-finance",
  tags: ["solana", "jupiter", "perpetuals", "defi", "leverage", "trading", "risk-management"],
  chains: ["solana"],
  author: {
    name: "PayBox Jupiter Perps Team",
    url: "https://developer.paybox.sh",
  },
  homepage: "https://developer.paybox.sh",
  repository: "https://github.com/moonpay/paybox",
  license: "MIT",
  transports: {
    mcp_streamable_http: "/mcp",
    mcp_sse: "/sse",
    openapi: "/openapi.json",
    contract: "/contract.json",
    x402: {
      quote: "/x402/quote",
      trade: "/x402/trade",
    },
  },
  tools: JUPITER_PERPS_PLUGIN_CONTRACT.tools.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
  })),
};
