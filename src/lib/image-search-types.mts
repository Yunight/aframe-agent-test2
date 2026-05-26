export type ImageSearchProviderId = 'brave' | 'anthropic';

export type ImageSearchRow = {
  url: string;
  title: string;
  source: string;
  page_fetched?: string;
  thumbnail?: { src: string; width?: number; height?: number };
  properties?: {
    url: string;
    placeholder?: string;
    width?: number;
    height?: number;
  };
};
