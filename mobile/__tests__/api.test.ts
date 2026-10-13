import {absoluteUrl, normalizeServerUrl} from '../src/api';

describe('ShelfStream mobile API URLs', () => {
  it('normalizes the configured server once', () => {
    expect(normalizeServerUrl('shelf-stream.com/')).toBe('https://shelf-stream.com');
    expect(normalizeServerUrl('http://192.168.0.83:9191/')).toBe('http://192.168.0.83:9191');
  });

  it('resolves protected API media paths against the selected server', () => {
    expect(absoluteUrl('https://shelf-stream.com', '/api/books/example/cover')).toBe(
      'https://shelf-stream.com/api/books/example/cover',
    );
    expect(absoluteUrl('https://shelf-stream.com', 'https://cdn.example/cover.jpg')).toBe(
      'https://cdn.example/cover.jpg',
    );
  });
});
