const nextConfig = {
  productionBrowserSourceMaps: false,

  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store"
          }
        ]
      }
    ];
  }
};

export default nextConfig;

/**
 * Em Next.js:
 *
 * NEXT_PUBLIC_* vai para o browser.
 *
 * Portanto, nenhuma credencial deve usar esse prefixo.
 */
