import { useState } from "react";
import type { FlowNode } from "./model.ts";
import { mediaUrl, playerUrl } from "./media.ts";
import { openExternal } from "../library/desktop";

export default function MediaView({ node }: { node: Extract<FlowNode, { type: "media" }> }) {
  const [active, setActive] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = node.kind === "embed" ? playerUrl(node.src) : mediaUrl(node.src);
  return <span className="flow-media" data-reader-interactive onClick={(event) => event.stopPropagation()} onMouseUp={(event) => event.stopPropagation()}>
    {!active && src ? <button type="button" className="flow-media-load" onClick={() => setActive(true)}>▶ {node.value || (node.kind === "audio" ? "Play audio" : "Play video")}</button> : null}
    {active && src && !failed ? node.kind === "embed" ? <iframe title={node.value || "Video player"} src={src} loading="lazy" allow="fullscreen; picture-in-picture" sandbox="allow-scripts allow-same-origin allow-presentation" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /> :
      node.kind === "audio" ? <audio controls preload="none" src={src} onError={() => setFailed(true)} /> : <video controls playsInline preload="none" src={src} poster={node.poster ? mediaUrl(node.poster) ?? undefined : undefined} onError={() => setFailed(true)} /> : null}
    {failed ? <small>This player could not load. It may require the original site or a different video format.</small> : <small>Playback needs an internet connection.</small>}
    {mediaUrl(node.src) ? <button type="button" className="flow-media-original" onClick={() => void openExternal(node.src)}>Open original media</button> : <small>Media file not included: {node.src}</small>}
  </span>;
}
