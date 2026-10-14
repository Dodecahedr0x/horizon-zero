import { useMemo } from "react";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import { App } from "./App";
import { RPC_URL } from "./network";
import { createSolanaChain } from "./solanaChain";

function SolanaApp() {
  const wallet = useWallet();
  const made = useMemo(() => {
    try {
      return { chain: createSolanaChain(wallet), error: "" };
    } catch (err) {
      return { chain: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [wallet.publicKey, wallet.sendTransaction, wallet.signTransaction]);
  // A misconfigured build (no rollup endpoint) says so instead of rendering a blank page.
  if (!made.chain) return <p role="alert" style={{ padding: 16 }}>{made.error}</p>;
  return <App chain={made.chain} connected={!!wallet.publicKey} wallet={<WalletMultiButton />} />;
}

export function SolanaRoot() {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SolanaApp />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
