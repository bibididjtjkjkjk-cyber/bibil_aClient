const SCALE = 4;

const UV = {
  head: {
    front: [8, 8, 8, 8], back: [24, 8, 8, 8], right: [0, 8, 8, 8], left: [16, 8, 8, 8],
    top: [8, 0, 8, 8], bottom: [16, 0, 8, 8],
  },
  torso: {
    front: [20, 20, 8, 12], back: [32, 20, 8, 12], right: [16, 20, 4, 12], left: [28, 20, 4, 12],
    top: [20, 16, 8, 4], bottom: [28, 16, 8, 4],
  },
  armLeft: {
    front: [36, 52, 4, 12], back: [44, 52, 4, 12], right: [32, 52, 4, 12], left: [40, 52, 4, 12],
    top: [36, 48, 4, 4], bottom: [40, 48, 4, 4],
  },
  armRight: {
    front: [44, 20, 4, 12], back: [52, 20, 4, 12], right: [40, 20, 4, 12], left: [48, 20, 4, 12],
    top: [44, 16, 4, 4], bottom: [48, 16, 4, 4],
  },
  legLeft: {
    front: [20, 52, 4, 12], back: [28, 52, 4, 12], right: [16, 52, 4, 12], left: [24, 52, 4, 12],
    top: [20, 48, 4, 4], bottom: [24, 48, 4, 4],
  },
  legRight: {
    front: [4, 20, 4, 12], back: [12, 20, 4, 12], right: [0, 20, 4, 12], left: [8, 20, 4, 12],
    top: [4, 16, 4, 4], bottom: [8, 16, 4, 4],
  },
};

function crop(source, rect) {
  const [x, y, width, height] = rect;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  if (y + height <= source.naturalHeight) context.drawImage(source, x, y, width, height, 0, 0, width, height);
  else {
    const fromY = y >= 32 ? 20 : 0;
    context.save();
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(source, x, fromY, width, height, 0, 0, width, height);
    context.restore();
  }
  return canvas.toDataURL('image/png');
}

function face(part, side, rect, width, height, depth) {
  const el = document.createElement('div');
  el.className = `skin-face skin-face-${side}`;
  const w = width * SCALE;
  const h = height * SCALE;
  const d = depth * SCALE;
  let faceWidth = w;
  let faceHeight = h;
  const transforms = {
    front: `translateZ(${d / 2}px)`,
    back: `rotateY(180deg) translateZ(${d / 2}px)`,
    right: 'rotateY(90deg)',
    left: 'rotateY(-90deg)',
    top: 'rotateX(90deg)',
    bottom: 'rotateX(-90deg)',
  };
  if (side === 'right' || side === 'left') faceWidth = d;
  if (side === 'top' || side === 'bottom') faceHeight = d;
  const left = side === 'right' ? width * SCALE - faceWidth / 2
    : side === 'left' ? -faceWidth / 2 : 0;
  const top = side === 'top' ? -faceHeight / 2
    : side === 'bottom' ? height * SCALE - faceHeight / 2 : 0;
  Object.assign(el.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${faceWidth}px`,
    height: `${faceHeight}px`,
    backgroundImage: `url("${crop(part, rect)}")`,
    backgroundSize: '100% 100%',
    transform: transforms[side],
  });
  return el;
}

function makePart(source, name, width, height, depth) {
  const part = document.createElement('div');
  part.className = `skin-part skin-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  Object.assign(part.style, { width: `${width * SCALE}px`, height: `${height * SCALE}px` });
  for (const [side, rect] of Object.entries(UV[name])) part.append(face(source, side, rect, width, height, depth));
  return part;
}

/** Renders a textured 3D player model and returns a disposer for pointer listeners. */
export function skinPreview(stage, skin, { walking = false, cape = false } = {}) {
  stage.replaceChildren();
  const image = new Image();
  image.onload = () => {
    if (!stage.isConnected) return;
    const model = document.createElement('div');
    model.className = `skin-model${walking ? ' walking' : ''}`;
    model.style.transform = `scale(.66) rotateY(${angle}deg)`;
    model.append(
      makePart(image, 'head', 8, 8, 8),
      makePart(image, 'torso', 8, 12, 4),
      makePart(image, 'armLeft', skin.model === 'slim' ? 3 : 4, 12, 4),
      makePart(image, 'armRight', skin.model === 'slim' ? 3 : 4, 12, 4),
      makePart(image, 'legLeft', 4, 12, 4),
      makePart(image, 'legRight', 4, 12, 4));
    if (cape) {
      const cloth = document.createElement('div');
      cloth.className = 'skin-cape';
      model.append(cloth);
    }
    stage.append(model);
    stage._skinModel = model;
  };
  image.src = skin.dataUrl;

  let angle = -16;
  let startX = 0;
  let dragging = false;
  const onDown = (event) => {
    dragging = true;
    startX = event.clientX;
    stage.setPointerCapture(event.pointerId);
  };
  const onMove = (event) => {
    if (!dragging) return;
    angle += (event.clientX - startX) * .8;
    startX = event.clientX;
    if (stage._skinModel) stage._skinModel.style.transform = `scale(.66) rotateY(${angle}deg)`;
  };
  const onUp = () => { dragging = false; };
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  return () => {
    stage.removeEventListener('pointerdown', onDown);
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('pointerup', onUp);
    stage.removeEventListener('pointercancel', onUp);
  };
}
