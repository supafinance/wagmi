import {
  type Transport,
  type TransportConfig,
  createTransport,
  type Chain,
} from 'viem'

import {
  type CreateConnectorFn,
  type ConnectorEventMap,
} from './connectors/createConnector.js'
import { Emitter } from './createEmitter.js'

type EthereumProvider = { request(...args: any): Promise<any> }

export type ConnectorTransportConfig = {
  /** The key of the transport. */
  key?: TransportConfig['key']
  /** The name of the transport. */
  name?: TransportConfig['name']
  /** The max number of times to retry. */
  retryCount?: TransportConfig['retryCount']
  /** The base delay (in ms) between retries. */
  retryDelay?: TransportConfig['retryDelay']
}

export type ConnectorTransport = Transport<
  'connector',
  {},
  EthereumProvider['request']
>

// export type ConnectorTransportErrorType = CreateTransportErrorType | ErrorType

type Connector = {
  getProvider: () => Promise<EthereumProvider>
}

export function experimental_connector(
  createConnectorFns: CreateConnectorFn[],
  config: ConnectorTransportConfig = {},
  connectorConfig: {
    chains: readonly [Chain, ...Chain[]]
    emitter: Emitter<ConnectorEventMap>
  },
): ConnectorTransport {
  const { key = 'connector', name = 'Connector Provider', retryDelay } = config

  let successfulConnector: Connector | null = null

  // Loop through connectors to find a successful one
  createConnectorFns.forEach(async (createConnectorFn) => {
    try {
      const connector = createConnectorFn(connectorConfig) as Connector
      const provider = await connector.getProvider()
      if (provider) {
        successfulConnector = connector
      }
    } catch (error) {
      console.error(`Connector failed: ${error}`)
    }
  })

  if (!successfulConnector) {
    // todo: error handling for the fallback function
  }

  return ({ retryCount: defaultRetryCount }) =>
    createTransport({
      key,
      name,
      request: async ({ method, params }) => {
        const provider =
          (await successfulConnector!.getProvider()) as EthereumProvider
        return provider.request({ method, params })
      },
      retryCount: config.retryCount ?? defaultRetryCount,
      retryDelay,
      type: 'connector',
    })
}
