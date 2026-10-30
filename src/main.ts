import { mount } from 'svelte';
// Fonts ship with the app so it works offline (latin subsets: Spanish needs latin-ext for Ñ).
import '@fontsource/rubik-glitch/latin.css';
import '@fontsource/rubik-glitch/latin-ext.css';
import '@fontsource/rubik-glitch-pop/latin.css';
import '@fontsource/rubik-glitch-pop/latin-ext.css';
import '@fontsource/martian-mono/latin-400.css';
import '@fontsource/martian-mono/latin-500.css';
import '@fontsource/martian-mono/latin-ext-400.css';
import '@fontsource/martian-mono/latin-ext-500.css';
import '@fontsource/doto/latin-700.css';
import '@fontsource/doto/latin-800.css';
import './styles/tokens.css';
import App from './app/App.svelte';

mount(App, { target: document.getElementById('app')! });
