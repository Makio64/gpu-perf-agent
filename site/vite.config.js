import { defineConfig } from 'vite';

export default defineConfig( {
	base: './',
	server: {
		port: 5184,
		open: false,
	},
	build: {
		outDir: 'dist',
		assetsInlineLimit: 4096,
		target: 'es2022',
	},
} );
