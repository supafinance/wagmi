import {
  type EIP6963ProviderDetail,
  type Store as MipdStore,
  createStore as createMipd,
} from 'mipd'
import {
  type Address,
  type Chain,
  type Client,
  type ClientConfig as viem_ClientConfig,
  type Transport,
  createClient,
  custom,
} from 'viem'
import { persist, subscribeWithSelector } from 'zustand/middleware'
import { type Mutate, type StoreApi, createStore } from 'zustand/vanilla'

import {
  type ConnectorEventMap,
  type CreateConnectorFn,
} from './connectors/createConnector.js'
import { injected } from './connectors/injected.js'
import { Emitter, type EventData, createEmitter } from './createEmitter.js'
import { type Storage, createStorage, noopStorage } from './createStorage.js'
import { ChainNotConfiguredError } from './errors/config.js'
import type { Evaluate, ExactPartial, LooseOmit, OneOf } from './types/utils.js'
import { uid } from './utils/uid.js'

type EthereumProvider = { request(...args: any): Promise<any> }

export type CreateConfigParameters<
  chains extends readonly [Chain, ...Chain[]] = readonly [Chain, ...Chain[]],
  transports extends Record<chains[number]['id'], Transport> = Record<
    chains[number]['id'],
    Transport
  >,
> = Evaluate<
  {
    chains: chains
    connectors?: CreateConnectorFn[] | undefined
    multiInjectedProviderDiscovery?: boolean | undefined
    storage?: Storage | null | undefined
    ssr?: boolean | undefined
    syncConnectedChain?: boolean | undefined
  } & OneOf<
    | ({ transports: transports } & {
        [key in keyof ClientConfig]?:
          | ClientConfig[key]
          | { [_ in chains[number]['id']]?: ClientConfig[key] | undefined }
          | undefined
      })
    | {
        client(parameters: { chain: chains[number] }): Client<
          transports[chains[number]['id']],
          chains[number]
        >
      }
  >
>

export function createConfig<
  const chains extends readonly [Chain, ...Chain[]],
  transports extends Record<chains[number]['id'], Transport>,
>(
  parameters: CreateConfigParameters<chains, transports>,
): Config<chains, transports> {
  const {
    chains,
    multiInjectedProviderDiscovery = true,
    storage = createStorage({
      storage:
        typeof window !== 'undefined' && window.localStorage
          ? window.localStorage
          : noopStorage,
    }),
    syncConnectedChain = true,
    ssr,
    ...rest
  } = parameters

  /////////////////////////////////////////////////////////////////////////////////////////////////
  // Set up connectors, clients, etc.
  /////////////////////////////////////////////////////////////////////////////////////////////////

  const mipd =
    typeof window !== 'undefined' && multiInjectedProviderDiscovery
      ? createMipd()
      : undefined

  const connectors = createStore(() =>
    [
      ...(rest.connectors ?? []),
      ...(!ssr
        ? mipd?.getProviders().map(providerDetailToConnector) ?? []
        : []),
    ].map(setup),
  )
  function setup(connectorFn: CreateConnectorFn) {
    // Set up emitter with uid and add to connector so they are "linked" together.
    const emitter = createEmitter<ConnectorEventMap>(uid())
    const connector = {
      ...connectorFn({ emitter, chains, storage }),
      emitter,
      uid: emitter.uid,
    }

    // Start listening for `connect` events on connector setup
    // This allows connectors to "connect" themselves without user interaction (e.g. MetaMask's "Manually connect to current site")
    emitter.on('connect', connect)
    connector.setup?.()

    return connector
  }
  function providerDetailToConnector(providerDetail: EIP6963ProviderDetail) {
    const { info, provider } = providerDetail
    return injected({
      target: { ...info, id: info.rdns, provider: provider as any },
    })
  }

  const clients = new Map<number, Client<Transport, chains[number]>>()
  function getClient<chainId extends chains[number]['id']>(
    config: { chainId?: chainId | chains[number]['id'] | undefined } = {},
  ): Client<Transport, Extract<chains[number], { id: chainId }>> {
    const chainId = config.chainId ?? store.getState().chainId
    const chain = chains.find((x) => x.id === chainId)

    // If the target chain is not configured, use the client of the current chain.
    type Return = Client<Transport, Extract<chains[number], { id: chainId }>>
    {
      const client = clients.get(store.getState().chainId)
      if (client && !chain) return client as Return
      else if (!chain) throw new ChainNotConfiguredError()
    }

    // If a memoized client exists for a chain id, use that.
    {
      const client = clients.get(chainId)
      if (client) return client as Return
    }

    const connectorState = connectors.getState()
    if (Array.isArray(connectorState)) {
      for (const connector of connectorState) {
        if (connector.uid !== store.getState().current) continue

        if (connector.isPriorityProvider) {
          return createClient({
            ...connector,
            chain,
            batch: { multicall: true },
            transport: custom({
              async request({ method, params }) {
                const provider =
                  (await connector.getProvider()) as EthereumProvider
                return provider.request({ method, params })
              },
            }),
          }) as Client<Transport, Extract<chains[number], { id: chainId }>>
        }
      }
    }

    let client
    if (rest.client) client = rest.client({ chain })
    else {
      const chainId = chain.id as chains[number]['id']
      // Grab all properties off `rest` and resolve for use in `createClient`
      const properties: Partial<viem_ClientConfig> = {}
      const entries = Object.entries(rest) as [keyof typeof rest, any][]
      for (const [key, value] of entries) {
        if (key === 'client' || key === 'connectors' || key === 'transports')
          continue
        else {
          if (typeof value === 'object') properties[key] = value[chainId]
          else properties[key] = value
        }
      }
      client = createClient({
        ...properties,
        chain,
        batch: properties.batch ?? { multicall: true },
        transport: rest.transports[chainId],
      })
    }

    clients.set(chainId, client)
    return client as Return
  }

  /////////////////////////////////////////////////////////////////////////////////////////////////
  // Create store
  /////////////////////////////////////////////////////////////////////////////////////////////////

  const initialState: State = {
    chainId: chains[0].id,
    connections: new Map(),
    current: undefined,
    status: 'disconnected',
  }

  const store = createStore(
    subscribeWithSelector(
      // only use persist middleware if storage exists
      storage
        ? persist(() => initialState, {
            name: 'store',
            partialize(state) {
              return {
                connections: state.connections,
                chainId: state.chainId,
                current: state.current,
              } satisfies PartializedState
            },
            skipHydration: ssr,
            storage: storage as Storage<Record<string, unknown>>,
            version: 1,
          })
        : () => initialState,
    ),
  )

  /////////////////////////////////////////////////////////////////////////////////////////////////
  // Subscribe to changes
  /////////////////////////////////////////////////////////////////////////////////////////////////

  // Update default chain when connector chain changes
  if (syncConnectedChain)
    store.subscribe(
      ({ connections, current }) =>
        current ? connections.get(current)?.chainId : undefined,
      (chainId) => {
        // If chain is not configured, then don't switch over to it.
        const isChainConfigured = chains.some((x) => x.id === chainId)
        if (!isChainConfigured) return

        return store.setState((x) => ({
          ...x,
          chainId: chainId ?? x.chainId,
        }))
      },
    )

  // EIP-6963 subscribe for new wallet providers
  mipd?.subscribe((providerDetails) => {
    for (const providerDetail of providerDetails) {
      const connector = setup(providerDetailToConnector(providerDetail))
      connectors.setState((x) => [...x, connector])
    }
  })

  /////////////////////////////////////////////////////////////////////////////////////////////////
  // Emitter listeners
  /////////////////////////////////////////////////////////////////////////////////////////////////

  function change(data: EventData<ConnectorEventMap, 'change'>) {
    store.setState((x) => {
      const connection = x.connections.get(data.uid)!
      return {
        ...x,
        connections: new Map(x.connections).set(data.uid, {
          accounts:
            (data.accounts as readonly [Address, ...Address[]]) ??
            connection.accounts,
          chainId: data.chainId ?? connection.chainId,
          connector: connection.connector,
        }),
      }
    })
  }
  function connect(data: EventData<ConnectorEventMap, 'connect'>) {
    // Disable handling if reconnecting/connecting
    if (
      store.getState().status === 'connecting' ||
      store.getState().status === 'reconnecting'
    )
      return

    store.setState((x) => {
      const connector = connectors.getState().find((x) => x.uid === data.uid)
      if (!connector) return x
      return {
        ...x,
        connections: new Map(x.connections).set(data.uid, {
          accounts: data.accounts as readonly [Address, ...Address[]],
          chainId: data.chainId,
          connector: connector,
        }),
        current: data.uid,
        status: 'connected',
      }
    })
  }
  function disconnect(data: EventData<ConnectorEventMap, 'disconnect'>) {
    store.setState((x) => {
      const connection = x.connections.get(data.uid)
      if (connection) {
        connection.connector.emitter.off('change', change)
        connection.connector.emitter.off('disconnect', disconnect)
        connection.connector.emitter.on('connect', connect)
      }

      x.connections.delete(data.uid)

      if (x.connections.size === 0)
        return {
          ...x,
          connections: new Map(),
          current: undefined,
          status: 'disconnected',
        }

      const nextConnection = x.connections.values().next().value as Connection
      return {
        ...x,
        connections: new Map(x.connections),
        current: nextConnection.connector.uid,
      }
    })
  }

  return {
    chains: chains as chains,
    get connectors() {
      return connectors.getState()
    },
    storage,

    getClient,
    get state() {
      return store.getState() as unknown as State<chains>
    },
    setState(value) {
      let newState: State
      if (typeof value === 'function') newState = value(store.getState() as any)
      else newState = value

      // Reset state if it got set to something not matching the base state
      if (typeof newState !== 'object') newState = initialState
      const isCorrupt = Object.keys(initialState).some((x) => !(x in newState))
      if (isCorrupt) newState = initialState

      store.setState(newState, true)
    },
    subscribe(selector, listener, options) {
      return store.subscribe(
        selector as unknown as (state: State) => any,
        listener,
        options
          ? { ...options, fireImmediately: options.emitImmediately }
          : undefined,
      )
    },

    _internal: {
      mipd,
      store,
      ssr: Boolean(ssr),
      syncConnectedChain,
      transports: rest.transports as transports,
      connectors: {
        providerDetailToConnector,
        setup,
        setState: (value) =>
          connectors.setState(
            typeof value === 'function' ? value(connectors.getState()) : value,
            true,
          ),
        subscribe: (listener) => connectors.subscribe(listener),
      },
      events: { change, connect, disconnect },
    },
  }
}

/////////////////////////////////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////////////////////////////////

export type Config<
  chains extends readonly [Chain, ...Chain[]] = readonly [Chain, ...Chain[]],
  transports extends Record<chains[number]['id'], Transport> = Record<
    chains[number]['id'],
    Transport
  >,
> = {
  readonly chains: chains
  readonly connectors: readonly Connector[]
  readonly storage: Storage | null

  readonly state: State<chains>
  setState<tchains extends readonly [Chain, ...Chain[]] = chains>(
    value: State<tchains> | ((state: State<tchains>) => State<tchains>),
  ): void
  subscribe<state>(
    selector: (state: State<chains>) => state,
    listener: (state: state, previousState: state) => void,
    options?:
      | {
          emitImmediately?: boolean | undefined
          equalityFn?: ((a: state, b: state) => boolean) | undefined
        }
      | undefined,
  ): () => void

  getClient<chainId extends chains[number]['id']>(parameters?: {
    chainId?: chainId | chains[number]['id'] | undefined
  }): Client<transports[chainId], Extract<chains[number], { id: chainId }>>

  _internal: {
    readonly mipd: MipdStore | undefined
    readonly store: Mutate<StoreApi<any>, [['zustand/persist', any]]>
    readonly ssr: boolean
    readonly syncConnectedChain: boolean
    readonly transports: transports

    connectors: {
      providerDetailToConnector(
        providerDetail: EIP6963ProviderDetail,
      ): CreateConnectorFn
      setup(connectorFn: CreateConnectorFn): Connector
      setState(value: Connector[] | ((state: Connector[]) => Connector[])): void
      subscribe(
        listener: (
          state: readonly Connector[],
          prevState: readonly Connector[],
        ) => void,
      ): () => void
    }
    events: {
      change(data: EventData<ConnectorEventMap, 'change'>): void
      connect(data: EventData<ConnectorEventMap, 'connect'>): void
      disconnect(data: EventData<ConnectorEventMap, 'disconnect'>): void
    }
  }
}

export type State<
  chains extends readonly [Chain, ...Chain[]] = readonly [Chain, ...Chain[]],
> = {
  chainId: chains[number]['id']
  connections: Map<string, Connection>
  current: string | undefined
  status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting'
}

export type PartializedState = Evaluate<
  ExactPartial<Pick<State, 'chainId' | 'connections' | 'current' | 'status'>>
>

export type Connection = {
  accounts: readonly [Address, ...Address[]]
  chainId: number
  connector: Connector
}

export type Connector = ReturnType<CreateConnectorFn> & {
  emitter: Emitter<ConnectorEventMap>
  uid: string
}

type ClientConfig = LooseOmit<
  viem_ClientConfig,
  'account' | 'chain' | 'key' | 'name' | 'transport' | 'type'
>
