import { CodeGenerator } from './base';
import { HtmlGenerator } from './html';
import { ReactGenerator } from './react';
import { VueGenerator } from './vue';

export type Platform = 'react' | 'vue' | 'html';

export function createGenerator(platform: Platform): CodeGenerator {
  switch (platform) {
    case 'react':
      return new ReactGenerator();
    case 'vue':
      return new VueGenerator();
    case 'html':
      return new HtmlGenerator();
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

export { HtmlGenerator, ReactGenerator, VueGenerator };
