import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const cesium = 'node_modules/cesium/Build/Cesium';

export default defineConfig({
  // Relative Pfade: läuft auf GitHub Pages (Unterordner), lokal und später in einer Desktop-Hülle
  base: './',
  plugins: [
    viteStaticCopy({
      targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets'].map((dir) => ({
        src: `${cesium}/${dir}`,
        dest: 'cesium',
        rename: { stripBase: 4 }, // node_modules/cesium/Build/Cesium/… → cesium/…
      })),
    }),
  ],
  // Module-Worker (Wolken-Worker, und satellite.js bringt einen WASM-Worker mit)
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
});
