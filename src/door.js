// The door's camera: a photo of the ticket (on a phone, the photo picker opens the camera) is
// decoded here with symbology's WebAssembly decoder, and the code goes into the door's form,
// which sends it. Served as /scripts/door.js; symbology is served from /vendor/symbology/.
import { loadQr } from '/vendor/symbology/qr.js';

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
const qr = loadQr();

/** An image as symbology's frame: one byte of brightness per pixel, at most 1280 × 720. */
async function frameOf(file) {
  const image = await createImageBitmap(file);
  const scale = Math.min(1, MAX_WIDTH / image.width, MAX_HEIGHT / image.height);
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const luma = new Uint8Array(width * height);
  for (let i = 0; i < luma.length; i++) luma[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  return { width, height, luma };
}

const photo = document.querySelector('#ticket-photo');
const said = document.querySelector('#photo-problem');
photo?.addEventListener('change', async () => {
  const file = photo.files?.[0];
  photo.value = '';
  if (!file) return;
  said.textContent = '';
  try {
    const code = (await qr).decodeText(await frameOf(file));
    const form = document.querySelector('door-scanner form');
    form.elements.ticket.value = code;
    form.requestSubmit();
  } catch {
    said.textContent = 'No ticket code found in that photo. Try again, closer and straight on, or type the code.';
  }
});
