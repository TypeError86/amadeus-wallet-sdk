/**
 * React ergonomics for dApps: a single `useWallet()` hook over the injected
 * provider client. It fixes the `amadeus#initialized` vs `amadeus-wallet#initialized`
 * detection bug once (dApps historically listened for the wrong name) and wires
 * the provider's account/network/disconnect events into state.
 *
 * Imported from the `@amadeus-protocol/wallet-sdk/react` subpath so non-React
 * consumers (the mobile wallet, node verifiers) never pull in React.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { createInjectedWalletClient, type WalletClient } from '../client/injected'
import { WALLET_INITIALIZED_EVENT } from '../constants'
import type {
	AmadeusEventPayloadMap,
	SignTransactionRequest,
	SignTransactionResponse
} from '../types'

export type WalletStatus = 'unavailable' | 'disconnected' | 'connecting' | 'connected'

export interface UseWalletResult {
	client: WalletClient
	status: WalletStatus
	account: string | null
	network: string | null
	isAvailable: boolean
	connect: () => Promise<void>
	disconnect: () => void
	signTransaction: (request: SignTransactionRequest) => Promise<SignTransactionResponse>
	signAndSubmit: WalletClient['signAndSubmit']
	ensureApiKey: WalletClient['ensureApiKey']
}

export function useWallet(): UseWalletResult {
	const client = useMemo(() => createInjectedWalletClient(), [])
	const [status, setStatus] = useState<WalletStatus>(() =>
		client.isAvailable() ? 'disconnected' : 'unavailable'
	)
	const [account, setAccount] = useState<string | null>(null)
	const [network, setNetwork] = useState<string | null>(null)

	// Detect a (possibly late-injected) provider, then read initial account/network.
	useEffect(() => {
		if (typeof window === 'undefined') return
		const onInit = () => {
			if (client.isAvailable()) setStatus((s) => (s === 'unavailable' ? 'disconnected' : s))
		}
		window.addEventListener(WALLET_INITIALIZED_EVENT, onInit)
		if (client.isAvailable()) {
			client
				.getAccount()
				.then((a) => {
					if (a) {
						setAccount(a)
						setStatus('connected')
					}
				})
				.catch(() => {})
			client
				.getNetwork()
				.then(setNetwork)
				.catch(() => {})
		}
		return () => window.removeEventListener(WALLET_INITIALIZED_EVENT, onInit)
	}, [client])

	// Mirror provider events into state.
	useEffect(() => {
		if (!client.isAvailable()) return
		const applyAccounts = (accounts: string[]) => {
			const next = accounts[0] ?? null
			setAccount(next)
			setStatus(next ? 'connected' : 'disconnected')
		}
		const onAccountsChanged = (d: AmadeusEventPayloadMap['accountsChanged']) =>
			applyAccounts(d.accounts)
		const onConnect = (d: AmadeusEventPayloadMap['connect']) => {
			applyAccounts(d.accounts)
			setNetwork(d.network)
		}
		const onDisconnect = () => {
			setAccount(null)
			setStatus('disconnected')
		}
		const onNetworkChanged = (d: AmadeusEventPayloadMap['networkChanged']) =>
			setNetwork(d.network)

		client.on('accountsChanged', onAccountsChanged)
		client.on('connect', onConnect)
		client.on('disconnect', onDisconnect)
		client.on('networkChanged', onNetworkChanged)
		return () => {
			client.off('accountsChanged', onAccountsChanged)
			client.off('connect', onConnect)
			client.off('disconnect', onDisconnect)
			client.off('networkChanged', onNetworkChanged)
		}
	}, [client])

	const connect = useCallback(async () => {
		setStatus('connecting')
		try {
			const a = await client.connect()
			setAccount(a)
			setStatus('connected')
		} catch (error) {
			setStatus(client.isAvailable() ? 'disconnected' : 'unavailable')
			throw error
		}
	}, [client])

	const disconnect = useCallback(() => {
		setAccount(null)
		setStatus('disconnected')
	}, [])

	return {
		client,
		status,
		account,
		network,
		isAvailable: client.isAvailable(),
		connect,
		disconnect,
		signTransaction: client.signTransaction,
		signAndSubmit: client.signAndSubmit,
		ensureApiKey: client.ensureApiKey
	}
}
