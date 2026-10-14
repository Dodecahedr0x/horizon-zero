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
  const chain = useMemo(() => createSolanaChain(wallet), [wallet.publicKey, wallet.sendTransaction]);
  return <App chain={chain} connected={!!wallet.publicKey} wallet={<WalletMultiButton />} />;
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
