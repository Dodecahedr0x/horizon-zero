import { useEffect, useMemo, useState } from "react";
import { App } from "./App";
import { createLocalChain } from "./localChain";

export function DevApp() {
  const chain = useMemo(() => createLocalChain(), []);
  const [label, setLabel] = useState("");
  useEffect(() => {
    let alive = true;
    chain.label().then((value) => {
      if (alive) setLabel(value);
    }).catch(() => {
      if (alive) setLabel("");
    });
    return () => {
      alive = false;
    };
  }, [chain]);
  return <App chain={chain} connected identity={label} />;
}
