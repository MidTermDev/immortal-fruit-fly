import Link from "next/link";
import styles from "./Observer.module.css";

export default function WatchSources({ current }: { current: "core" | "world" | "arcade" }) {
  return <nav className={styles.subnav} aria-label="Watch source">
    <Link href="/" aria-current={current === "core" ? "page" : undefined}>On-chain circuit</Link>
    <Link href="/world/" aria-current={current === "world" ? "page" : undefined}>Whole brain</Link>
    <Link href="/arcade/" aria-current={current === "arcade" ? "page" : undefined}>DOOM</Link>
  </nav>;
}
