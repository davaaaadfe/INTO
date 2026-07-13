export type PreviewPan = {
  x: number;
  y: number;
};

export function resetPreviewPan(): PreviewPan {
  return { x: 0, y: 0 };
}

export function movePreviewPan(
  current: PreviewPan,
  delta: PreviewPan
): PreviewPan {
  return {
    x: current.x + delta.x,
    y: current.y + delta.y,
  };
}
