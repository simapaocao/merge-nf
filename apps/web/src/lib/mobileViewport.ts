type TouchLikeEvent = Event & {
  readonly touches?: { readonly length: number };
  readonly scale?: number;
};

/**
 * Prevent mobile pinch-to-zoom (including iOS Safari gesture events where
 * `user-scalable=no` is ignored) while preserving single-finger scrolling,
 * tapping, text selection, and desktop keyboard/wheel zoom.
 */
export function installMobileZoomGuard(target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  const preventGesture = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };
  const preventMultiTouch = (event: Event) => {
    const touch = event as TouchLikeEvent;
    const multiTouch = (touch.touches?.length ?? 0) > 1;
    const scaled = typeof touch.scale === 'number' && touch.scale !== 1;
    if ((multiTouch || scaled) && event.cancelable) event.preventDefault();
  };
  const options: AddEventListenerOptions = { passive: false };
  target.addEventListener('gesturestart', preventGesture, options);
  target.addEventListener('gesturechange', preventGesture, options);
  target.addEventListener('gestureend', preventGesture, options);
  target.addEventListener('touchstart', preventMultiTouch, options);
  target.addEventListener('touchmove', preventMultiTouch, options);
  return () => {
    target.removeEventListener('gesturestart', preventGesture, options);
    target.removeEventListener('gesturechange', preventGesture, options);
    target.removeEventListener('gestureend', preventGesture, options);
    target.removeEventListener('touchstart', preventMultiTouch, options);
    target.removeEventListener('touchmove', preventMultiTouch, options);
  };
}
