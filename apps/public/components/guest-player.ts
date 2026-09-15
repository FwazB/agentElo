import type { Me } from "../../../packages/public-api/types";
import { api } from "./shared";

export const validGuestName = (name: string) => /^[a-z][a-z0-9_]{2,19}$/.test(name);

// Web Locks cover all tabs on this origin. The fallback only serializes this tab;
// the server also refuses to rename an already-claimed guest session.
let guestQueue: Promise<unknown> = Promise.resolve();
export async function createGuestPlayer(username: string, isCurrent: () => boolean = () => true): Promise<Me> {
  if (!validGuestName(username)) throw new Error("Use 3–20 lowercase letters, numbers, or underscores, starting with a letter.");
  const claim = async () => {
    const check = () => { if (!isCurrent()) throw new Error("Your player changed. Please review before continuing."); };
    check();
    await api("/guest/session", { method: "POST", body: "{}" });
    check();
    const player = await api<Me>("/guest/player", { method: "POST", body: JSON.stringify({ username }) });
    check();
    return player;
  };
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("antislop-guest-player", claim);
  const result = guestQueue.then(claim, claim);
  guestQueue = result.then(() => undefined, () => undefined);
  return result;
}
