import type { z } from "zod";
import { makeLogger } from "../../logger";
import type { BridgeForwardMsg, BridgePeerUpdateMsg } from "../../protocol";
import type { PeerRegistry } from "../registry";

const log = makeLogger("federation");

export type FederationContext = {
    registry: PeerRegistry;
    onForward?: (msg: {
        target_peer: string;
        origin_hub: string;
        wrapped: Record<string, unknown>;
    }) => void;
};

export function handleBridgePeerUpdate(
    ctx: FederationContext,
    msg: z.infer<typeof BridgePeerUpdateMsg>,
    remoteHubId: string,
): void {
    if (msg.action === "join" && msg.peer) {
        ctx.registry.addRemotePeer(remoteHubId, msg.peer);
        log.info("remote_peer_join", { hub: remoteHubId, peer: msg.peer.name });
    } else if (msg.action === "leave" && msg.name) {
        ctx.registry.removeRemotePeer(remoteHubId, msg.name);
        log.info("remote_peer_leave", { hub: remoteHubId, peer: msg.name });
    }
}

export function handleBridgeForward(
    ctx: FederationContext,
    msg: z.infer<typeof BridgeForwardMsg>,
    remoteHubId: string,
): void {
    if (ctx.onForward) {
        ctx.onForward({ ...msg, origin_hub: remoteHubId });
    }
}
