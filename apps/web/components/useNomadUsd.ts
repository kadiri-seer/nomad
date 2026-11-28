"use client";

import { useEffect, useState } from "react";
import { nomadUsd } from "@/lib/nomad-price";

/** $NOMAD's live price in dollars (Stoa's quote, at most once a minute), or null until it answers. */
export function useNomadUsd(): number | null {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => nomadUsd().then((p) => live && setPrice(p)).catch(() => undefined);
    void read();
    const t = setInterval(read, 120_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return price;
}
