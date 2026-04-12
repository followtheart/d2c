import { CodeGenerator } from './base';
import { HtmlGenerator } from './html';
import { ReactGenerator } from './react';
import { VueGenerator } from './vue';
import { ReactNativeGenerator } from './reactNative';
import { FlutterGenerator } from './flutter';

export type Platform = 'react' | 'vue' | 'html' | 'react-native' | 'flutter';

export function createGenerator(platform: Platform): CodeGenerator {
  switch (platform) {
    case 'react':
      return new ReactGenerator();
    case 'vue':
      return new VueGenerator();
    case 'html':
      return new HtmlGenerator();
    case 'react-native':
      return new ReactNativeGenerator();
    case 'flutter':
      return new FlutterGenerator();
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

export {
  HtmlGenerator,
  ReactGenerator,
  VueGenerator,
  ReactNativeGenerator,
  FlutterGenerator,
};
