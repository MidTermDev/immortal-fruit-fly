import type { Metadata } from "next";
import Collection from "@/components/Collection";

export const metadata: Metadata = { title: "Immortal Fruit Flies · the collection", description: "10,000 whole fruit-fly brains at most, each an ERC-721 on BNB Smart Chain with its state, memory, lineage and history anchored forever. Mint for 1 $FLY." };

export default function Page() { return <Collection />; }
