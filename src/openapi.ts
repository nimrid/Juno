export function getOpenApiSpec(serverUrl: string = "http://localhost:3000") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Jupiter Perpetuals Copilot - PayBox Plugin",
      description:
        "Non-custodial leveraged perpetual trading, live oracle rates, and liquidation risk management on Solana, integrated with PayBox wallet and passkey authorization.",
      version: "1.0.0",
      contact: {
        name: "PayBox Jupiter Perps Copilot",
        url: "https://developer.paybox.sh",
      },
    },
    servers: [
      {
        url: serverUrl,
        description: "Jupiter Perps Copilot Server",
      },
    ],
    paths: {
      "/api/markets": {
        get: {
          summary: "Get Tradable Markets",
          description:
            "Fetch all tradable markets on Jupiter Perpetuals (SOL-PERP, BTC-PERP, ETH-PERP) with current mark prices, max leverage, and borrow/funding rates.",
          operationId: "getMarkets",
          responses: {
            "200": {
              description: "List of tradable markets and pricing parameters",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      markets: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            symbol: { type: "string", example: "SOL-PERP" },
                            name: { type: "string", example: "Solana" },
                            currentPrice: { type: "string", example: "$154.25" },
                            rawPriceUsd: { type: "number", example: 154.25 },
                            maxLeverage: { type: "string", example: "100x" },
                            openFee: { type: "string", example: "0.06%" },
                            closeFee: { type: "string", example: "0.06%" },
                            hourlyBorrowRate: { type: "string", example: "0.0012%" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/quote": {
        post: {
          summary: "Get Leverage Quote & Risk Analysis",
          description:
            "Calculate live parameters for opening a leverage position on Jupiter Perpetuals using on-chain Pyth oracles. Computes fees, exact liquidation price, margin requirements, distance to liquidation, and whether PayBox requires user passkey approval.",
          operationId: "getQuote",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["market", "side", "collateralUsd", "leverage"],
                  properties: {
                    market: {
                      type: "string",
                      enum: ["SOL-PERP", "BTC-PERP", "ETH-PERP"],
                      description: "Market pair to trade",
                      example: "SOL-PERP",
                    },
                    side: {
                      type: "string",
                      enum: ["long", "short"],
                      description: "Trade direction: long or short",
                      example: "long",
                    },
                    collateralUsd: {
                      type: "number",
                      description: "Margin amount in USD",
                      example: 50,
                    },
                    leverage: {
                      type: "number",
                      description: "Leverage multiplier",
                      example: 3,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Quote simulation and risk computation",
              content: {
                "application/json": {
                  schema: {
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
                },
              },
            },
          },
        },
      },
      "/api/positions": {
        get: {
          summary: "Get Wallet Open Positions",
          description:
            "Retrieve active open perpetual positions for a Solana wallet, including entry price, mark price, leverage, and real-time unrealized PnL.",
          operationId: "getPositions",
          parameters: [
            {
              name: "walletAddress",
              in: "query",
              required: false,
              description: "Solana base58 wallet address",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Active positions list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      walletAddress: { type: "string" },
                      activePositionsCount: { type: "number" },
                      positions: { type: "array" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/open": {
        post: {
          summary: "Open Leverage Trade via PayBox",
          description:
            "Constructs the on-chain Anchor VersionedTransaction and delegates non-custodial signing to PayBox. Low-risk trades execute autonomously; high-leverage trades pause for passkey approval.",
          operationId: "openPosition",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["market", "side", "collateralUsd", "leverage"],
                  properties: {
                    market: {
                      type: "string",
                      enum: ["SOL-PERP", "BTC-PERP", "ETH-PERP"],
                      example: "SOL-PERP",
                    },
                    side: {
                      type: "string",
                      enum: ["long", "short"],
                      example: "long",
                    },
                    collateralUsd: {
                      type: "number",
                      example: 25,
                    },
                    leverage: {
                      type: "number",
                      example: 2,
                    },
                    collateralToken: {
                      type: "string",
                      enum: ["USDC", "SOL"],
                      example: "SOL",
                    },
                    walletAddress: {
                      type: "string",
                      description: "Optional Solana wallet address",
                    },
                    credentialId: {
                      type: "string",
                      description: "Optional PayBox credential ID",
                    },
                    slippageBps: {
                      type: "number",
                      default: 50,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Prepared trade and PayBox signing metadata",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      tradeDetails: { type: "object" },
                      onChainRpcVerification: { type: "object" },
                      payboxMcpCall: { type: "object" },
                      agentNextStep: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/close": {
        post: {
          summary: "Close Perpetual Position via PayBox",
          description:
            "Constructs and delegates execution to PayBox to close or decrease an active Jupiter Perps position.",
          operationId: "closePosition",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["positionPubkey"],
                  properties: {
                    positionPubkey: {
                      type: "string",
                      description: "Base58 public key of position PDA",
                    },
                    walletAddress: { type: "string" },
                    credentialId: { type: "string" },
                    desiredReceiveToken: {
                      type: "string",
                      enum: ["USDC", "SOL"],
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Position close request details",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      closedPosition: { type: "object" },
                      payboxMcpCall: { type: "object" },
                      agentNextStep: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/simulate": {
        post: {
          summary: "Simulate On-Chain Solana Transaction",
          description:
            "Directly simulate any compiled base64 Solana VersionedTransaction against live Solana Mainnet RPC.",
          operationId: "simulateTransaction",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["transactionBase64"],
                  properties: {
                    transactionBase64: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Solana RPC simulation response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      unitsConsumed: { type: "number" },
                      err: { type: "any" },
                      logs: { type: "array" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/contract.json": {
        get: {
          summary: "Get Official PayBox Plugin Contract",
          description:
            "Returns the official PayBox Plugin Contract schema for discovery by PayBox CLI and MCP agents.",
          operationId: "getPluginContract",
          responses: {
            "200": {
              description: "PayBox Plugin Contract",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
    },
  };
}
