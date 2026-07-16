export type PreviewPan = {
  x: number;
  y: number;
};

export type PreviewPanBounds = {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
};

const minimumPreviewZoom = 0.7;
const maximumPreviewZoom = 3;
const previewZoomStep = 0.15;

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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampPreviewZoom(zoom: number) {
  return clamp(zoom, minimumPreviewZoom, maximumPreviewZoom);
}

export function zoomFromWheel(currentZoom: number, deltaY: number) {
  if (!deltaY) {
    return clampPreviewZoom(currentZoom);
  }

  return clampPreviewZoom(
    currentZoom + (deltaY < 0 ? previewZoomStep : -previewZoomStep)
  );
}

export function previewScrollAfterZoom(input: {
  currentZoom: number;
  nextZoom: number;
  scrollLeft: number;
  scrollTop: number;
  pointerX: number;
  pointerY: number;
}) {
  const ratio = input.nextZoom / input.currentZoom;
  return {
    left: Math.max(0, (input.scrollLeft + input.pointerX) * ratio - input.pointerX),
    top: Math.max(0, (input.scrollTop + input.pointerY) * ratio - input.pointerY),
  };
}

export function clampPreviewPan(
  pan: PreviewPan,
  bounds: PreviewPanBounds
): PreviewPan {
  const maxX = Math.max(0, (bounds.contentWidth - bounds.viewportWidth) / 2);
  const maxY = Math.max(0, (bounds.contentHeight - bounds.viewportHeight) / 2);

  return {
    x: clamp(pan.x, -maxX, maxX),
    y: clamp(pan.y, -maxY, maxY),
  };
}
