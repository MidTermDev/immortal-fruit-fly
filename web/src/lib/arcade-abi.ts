import { CFG } from "./config";

/** One deployment address shared with Activity and explorer links. */
export const ARCADE_ADDRESS = CFG.arcade;

export const ARCADE_ABI = [
  "function operator() view returns (address)",
  "function sessionCount() view returns (uint256)",
  "function sessions(uint256) view returns (string game,uint64 startBlock,uint64 endBlock,uint32 decisions,uint32 kills,bytes32 finalHash)",
  "event SessionStarted(uint256 indexed id,string game,bytes32 brainHash,uint64 brainStep)",
  "event Decision(uint256 indexed session,uint32 indexed n,bytes32 brainHash,uint64 brainStep,int16 turn,bool fire,uint32 spikes,uint16 kills,uint16 health,uint32 gameTic)",
  "event SessionEnded(uint256 indexed id,uint32 decisions,uint32 kills,bytes32 finalHash)",
] as const;
