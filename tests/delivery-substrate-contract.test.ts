import { MemoryStore } from "../src/adapters/memory-store.js";
import { runDeliverySubstrateContract } from "./helpers/delivery-substrate-contract.js";

runDeliverySubstrateContract("memory", () => new MemoryStore());
