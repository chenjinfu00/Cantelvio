/** Keep recorded voices and live notes in the same music-playback session. */
export function configurePlaybackSession(navigatorObject = globalThis.navigator) {
  try {
    if (navigatorObject?.audioSession && navigatorObject.audioSession.type !== "playback") {
      navigatorObject.audioSession.type = "playback";
    }
  } catch { /* The optional Audio Session API is not supported by every browser. */ }
}

export async function resumePlaybackContext(context) {
  configurePlaybackSession();
  if (context.state === "closed") throw new Error("Audio context was closed");
  // WebKit also exposes `interrupted`, for example after media or device changes.
  if (context.state !== "running") await context.resume();
  if (context.state !== "running") throw new Error("Audio output is paused");
  return context;
}
