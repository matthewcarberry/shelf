import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(root, '..', 'public', 'favicon.svg');
const iosDirectory = path.join(root, 'ios', 'ShelfStreamMobile', 'Images.xcassets', 'AppIcon.appiconset');
const iosIcons = [
  ['Icon-20@2x.png', 40], ['Icon-20@3x.png', 60],
  ['Icon-29@2x.png', 58], ['Icon-29@3x.png', 87],
  ['Icon-40@2x.png', 80], ['Icon-40@3x.png', 120],
  ['Icon-60@2x.png', 120], ['Icon-60@3x.png', 180],
  ['Icon-1024.png', 1024],
];

await fs.mkdir(iosDirectory, {recursive: true});
for (const [name, size] of iosIcons) {
  await sharp(source).resize(size, size).png().toFile(path.join(iosDirectory, name));
}

for (const [density, size] of Object.entries({mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192})) {
  const directory = path.join(root, 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`);
  await fs.mkdir(directory, {recursive: true});
  const icon = await sharp(source).resize(size, size).png().toBuffer();
  await fs.writeFile(path.join(directory, 'ic_launcher.png'), icon);
  await fs.writeFile(path.join(directory, 'ic_launcher_round.png'), icon);
}
