// A saved excerpt may open a lazily mounted conversation. Wait briefly for
// its stable turn ID rather than relying on a list index or text matching.
export function revealConversationTurn(turnId?: string) {
  if (!turnId) return;
  let remaining = 20;
  const reveal = () => {
    const element = document.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    if (element) element.scrollIntoView({ block: "center" });
    else if (--remaining > 0) setTimeout(reveal, 30);
  };
  requestAnimationFrame(reveal);
}
