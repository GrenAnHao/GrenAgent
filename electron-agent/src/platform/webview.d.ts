import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean | 'true' | 'false';
          webpreferences?: string;
        },
        HTMLElement
      >;
    }
  }
}

export {};
