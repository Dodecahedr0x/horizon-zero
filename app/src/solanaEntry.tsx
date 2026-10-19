import { useMemo } from "react";
import { WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import { App } from "./App";
import { createRemoteChain } from "./remoteChain";

function SolanaApp() {
  const wallet = useWallet();
  const chain = useMemo(() => createRemoteChain(wallet), [wallet.publicKey, wallet.signTransaction]);
  return <App chain={chain} connected={!!wallet.publicKey} wallet={<WalletMultiButton />} />;
}

// No ConnectionProvider: the page never talks to an RPC. The game server reads the chain and sends
// what the wallet signs (app/chain/http.mjs).
export function SolanaRoot() {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <WalletProvider wallets={wallets} autoConnect>
      <WalletModalProvider>
        <SolanaApp />
      </WalletModalProvider>
    </WalletProvider>
  );
}
