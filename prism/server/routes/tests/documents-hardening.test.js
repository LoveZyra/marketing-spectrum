/**
 * Hardening tests for server/routes/documents.js + server/shared/ip-guard.js.
 *
 * Written in vitest style (the runner is wired up separately); every assertion
 * sticks to the basic matchers (toBe / toEqual / toContain / toMatch and their
 * .not counterparts) so it also runs under a minimal shim.
 */

import { describe, it, expect } from 'vitest';

import {
  isPrivateIp,
  isPrivateIPv4,
  isPrivateIPv6,
  parseIPv4,
  expandIPv6,
} from '../../shared/ip-guard.js';
import {
  escapeAttachedDocumentTags,
  decodeTextBuffer,
  decodeXmlEntities,
  extractPlainText,
  looksBinary,
  htmlToText,
} from '../documents.js';

/* ------------------------------------------------------------------ */
/*  ip-guard: IPv4 ranges                                              */
/* ------------------------------------------------------------------ */

describe('ip-guard IPv4 ranges', () => {
  const privateV4 = [
    '0.0.0.0', '0.255.255.255',              // 0.0.0.0/8
    '10.0.0.1', '10.255.255.255',            // 10/8
    '100.64.0.1', '100.127.255.255',         // 100.64/10 CGNAT
    '127.0.0.1', '127.255.255.254',          // 127/8 loopback
    '169.254.169.254', '169.254.0.1',        // 169.254/16 link-local + metadata
    '172.16.0.1', '172.31.255.255',          // 172.16/12
    '192.0.0.1', '192.0.0.255',              // 192.0.0/24
    '192.0.2.1',                             // 192.0.2/24 TEST-NET-1
    '192.168.0.1', '192.168.255.255',        // 192.168/16
    '198.18.0.1', '198.19.255.255',          // 198.18/15 benchmarking
    '198.51.100.7',                          // TEST-NET-2
    '203.0.113.99',                          // TEST-NET-3
    '224.0.0.1', '239.255.255.255',          // 224/4 multicast
    '240.0.0.1', '255.255.255.254',          // 240/4 reserved
    '255.255.255.255',                       // limited broadcast
  ];
  it('flags every private/reserved IPv4 range', () => {
    for (const addr of privateV4) {
      expect(`${addr}=${isPrivateIPv4(addr)}`).toBe(`${addr}=true`);
      expect(`${addr}=${isPrivateIp(addr)}`).toBe(`${addr}=true`);
    }
  });

  const publicV4 = [
    '1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0',
    '100.63.255.255', '100.128.0.0',   // CGNAT neighbors
    '126.255.255.255', '128.0.0.1',    // loopback neighbors
    '169.253.255.255', '169.255.0.0',  // link-local neighbors
    '172.15.255.255', '172.32.0.0',    // 172.16/12 neighbors
    '192.0.1.1', '192.0.3.1',          // 192.0.0/24 + TEST-NET-1 neighbors
    '192.167.255.255', '192.169.0.0',  // 192.168/16 neighbors
    '198.17.255.255', '198.20.0.0',    // benchmarking neighbors
    '198.51.99.1', '198.51.101.1',
    '203.0.112.1', '203.0.114.1',
    '223.255.255.255',                 // last unicast before multicast
  ];
  it('accepts routable public IPv4 addresses (range boundary neighbors)', () => {
    for (const addr of publicV4) {
      expect(`${addr}=${isPrivateIPv4(addr)}`).toBe(`${addr}=false`);
      expect(`${addr}=${isPrivateIp(addr)}`).toBe(`${addr}=false`);
    }
  });

  it('fails closed on malformed IPv4 input', () => {
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp('999.1.1.1')).toBe(true);
    expect(isPrivateIp('1.2.3')).toBe(true);
    expect(isPrivateIPv4('010.0.0.1')).toBe(true);  // leading zero (octal ambiguity)
    expect(isPrivateIPv4('0x7f.0.0.1')).toBe(true); // hex form
    expect(parseIPv4('1.2.3.4')).toEqual([1, 2, 3, 4]);
    expect(parseIPv4('01.2.3.4')).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/*  ip-guard: IPv6 ranges (incl. mapped / NAT64 / fe9x link-local)      */
/* ------------------------------------------------------------------ */

describe('ip-guard IPv6 ranges', () => {
  it('flags unspecified, loopback and the deprecated ::/96 block', () => {
    expect(isPrivateIPv6('::')).toBe(true);
    expect(isPrivateIPv6('::1')).toBe(true);
    expect(isPrivateIPv6('0:0:0:0:0:0:0:1')).toBe(true);
  });

  it('recurses IPv4-mapped ::ffff:0:0/96 into the embedded IPv4', () => {
    expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);   // loopback
    expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);    // RFC1918
    expect(isPrivateIPv6('::ffff:169.254.169.254')).toBe(true); // metadata
    expect(isPrivateIPv6('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:7f00:1')).toBe(true);      // hex form of 127.0.0.1
    expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);    // public v4 stays public
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('recurses NAT64 64:ff9b::/96 into the embedded IPv4', () => {
    expect(isPrivateIPv6('64:ff9b::127.0.0.1')).toBe(true);
    expect(isPrivateIPv6('64:ff9b::7f00:1')).toBe(true);    // hex form of 127.0.0.1
    expect(isPrivateIPv6('64:ff9b::10.0.0.1')).toBe(true);
    expect(isPrivateIPv6('64:ff9b::8.8.8.8')).toBe(false);  // NAT64 of a public v4
    expect(isPrivateIPv6('64:ff9b:1::a00:1')).toBe(true);   // local-use NAT64 (RFC 8215)
  });

  it('flags unique-local fc00::/7', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fdab:cdef::1')).toBe(true);
    expect(isPrivateIPv6('fbff::1')).toBe(false); // just below fc00::/7
  });

  it('flags the FULL fe80::/10 link-local block (fe80–febf, incl. fe9x/feax/febx)', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('fe90::1')).toBe(true);   // fe9x — missed by naive startsWith('fe80')
    expect(isPrivateIPv6('fe9f::1')).toBe(true);
    expect(isPrivateIPv6('fea0::1')).toBe(true);
    expect(isPrivateIPv6('febf::ffff')).toBe(true);
    expect(isPrivateIPv6('fe7f::1')).toBe(false);  // below the /10
  });

  it('flags deprecated site-local fec0::/10', () => {
    expect(isPrivateIPv6('fec0::1')).toBe(true);
    expect(isPrivateIPv6('feff::1')).toBe(true);
  });

  it('flags documentation 2001:db8::/32 and multicast ff00::/8', () => {
    expect(isPrivateIPv6('2001:db8::1')).toBe(true);
    expect(isPrivateIPv6('2001:db8:ffff::1')).toBe(true);
    expect(isPrivateIPv6('ff02::1')).toBe(true);
    expect(isPrivateIPv6('ff05::fb')).toBe(true);
  });

  it('accepts genuinely public IPv6 addresses', () => {
    expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false); // Google DNS
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
    expect(isPrivateIPv6('2620:fe::fe')).toBe(false);          // Quad9
  });

  it('handles brackets and zone ids, and fails closed on garbage', () => {
    expect(isPrivateIp('[::1]')).toBe(true);
    expect(isPrivateIp('fe80::1%eth0')).toBe(true);
    expect(isPrivateIp('[fe80::1%25eth0]')).toBe(true);
    expect(isPrivateIp('zzzz::1')).toBe(true);       // not an IP — fail closed
    expect(isPrivateIPv6('1:2:3:4:5:6:7:8:9')).toBe(true);
    expect(expandIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIPv6('not-an-ip')).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/*  Attachment tag-boundary escaping                                    */
/* ------------------------------------------------------------------ */

describe('escapeAttachedDocumentTags', () => {
  it('neutralizes the literal closing tag (any case)', () => {
    expect(escapeAttachedDocumentTags('a </attached-document> b'))
      .toBe('a ＜/attached-document> b');
    expect(escapeAttachedDocumentTags('</ATTACHED-DOCUMENT>'))
      .toBe('＜/ATTACHED-DOCUMENT>');
    expect(escapeAttachedDocumentTags('x</Attached-Document y'))
      .toBe('x＜/Attached-Document y');
  });

  it('neutralizes every occurrence', () => {
    const out = escapeAttachedDocumentTags('</attached-document></attached-document>');
    expect(out).toBe('＜/attached-document>＜/attached-document>');
    expect(out).not.toContain('</attached-document');
  });

  it('leaves other markup (including the opening tag) untouched', () => {
    expect(escapeAttachedDocumentTags('<attached-document name="x">'))
      .toBe('<attached-document name="x">');
    expect(escapeAttachedDocumentTags('normal <b>html</b> and </attacheddocument>'))
      .toBe('normal <b>html</b> and </attacheddocument>');
  });
});

/* ------------------------------------------------------------------ */
/*  Encoding fallback chain                                             */
/* ------------------------------------------------------------------ */

describe('plain-text decoding', () => {
  it('decodes strict UTF-8 (and strips the BOM)', () => {
    const plain = decodeTextBuffer(Buffer.from('hello 世界', 'utf8'));
    expect(plain.encoding).toBe('utf-8');
    expect(plain.text).toBe('hello 世界');

    const withBom = decodeTextBuffer(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('bom text', 'utf8'),
    ]));
    expect(withBom.text).toBe('bom text');
  });

  it('falls back to GB18030 for real GB-encoded Chinese text', () => {
    // 中文文本 encoded as GB18030/GBK: D6D0 CEC4 CEC4 B1BE — invalid as UTF-8
    // (0xD6 lead is not followed by a continuation byte).
    const gb = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xce, 0xc4, 0xb1, 0xbe]);
    const decoded = decodeTextBuffer(gb);
    expect(decoded.encoding).toBe('gb18030');
    expect(decoded.text).toBe('中文文本');
    // and the full extractor path must NOT classify it as binary
    expect(extractPlainText(gb)).toBe('中文文本');
  });

  it('falls back to latin1 when nothing else fits', () => {
    // 0xFF is not a valid lead byte in UTF-8, GB18030 or Shift_JIS.
    const decoded = decodeTextBuffer(Buffer.from([0x68, 0x69, 0xff]));
    expect(decoded.encoding).toBe('latin1');
    expect(decoded.text).toBe('hiÿ');
  });

  it('looksBinary only triggers on raw NUL bytes', () => {
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    // high bytes alone (e.g. GB18030 leads) are NOT binary
    expect(looksBinary(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe(false);
    expect(looksBinary(Buffer.from('plain ascii'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  htmlToText quality                                                  */
/* ------------------------------------------------------------------ */

describe('htmlToText', () => {
  it('prefers <article> content and drops page chrome', () => {
    const html = `
      <html><head><title>My &amp; Title</title></head>
      <body>
        <nav>NAVJUNK home about</nav>
        <header>HEADERJUNK</header>
        <article><h1>Real Heading</h1><p>First para.</p><p>Second para.</p></article>
        <aside>ASIDEJUNK</aside>
        <footer>FOOTERJUNK copyright</footer>
        <form>FORMJUNK<input></form>
        <svg><text>SVGJUNK</text></svg>
        <iframe>IFRAMEJUNK</iframe>
        <noscript>NOSCRIPTJUNK</noscript>
      </body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe('My & Title');
    expect(text).toContain('Real Heading');
    expect(text).toContain('First para.');
    expect(text).toContain('Second para.');
    expect(text).not.toContain('NAVJUNK');
    expect(text).not.toContain('HEADERJUNK');
    expect(text).not.toContain('ASIDEJUNK');
    expect(text).not.toContain('FOOTERJUNK');
    expect(text).not.toContain('FORMJUNK');
    expect(text).not.toContain('SVGJUNK');
    expect(text).not.toContain('IFRAMEJUNK');
    expect(text).not.toContain('NOSCRIPTJUNK');
  });

  it('falls back to <main>, then <body>, stripping chrome blocks', () => {
    const viaMain = htmlToText(
      '<body><nav>NAVJUNK</nav><main><p>Main content.</p></main><footer>FOOTERJUNK</footer></body>',
    );
    expect(viaMain.text).toContain('Main content.');
    expect(viaMain.text).not.toContain('NAVJUNK');
    expect(viaMain.text).not.toContain('FOOTERJUNK');

    const viaBody = htmlToText(
      '<html><body><nav>NAVJUNK</nav><p>Body content.</p></body></html>',
    );
    expect(viaBody.text).toContain('Body content.');
    expect(viaBody.text).not.toContain('NAVJUNK');
  });

  it('converts <br> and closing block tags to newlines', () => {
    const { text } = htmlToText('<body><p>line one</p><p>two<br>three</p></body>');
    expect(text).toBe('line one\ntwo\nthree');
  });

  it('decodes numeric (dec + hex) and common named entities', () => {
    const { text } = htmlToText('<body><p>&#20013;&#x6587; &mdash; caf&#233;&nbsp;&amp; more</p></body>');
    expect(text).toContain('中文');
    expect(text).toContain('—');
    expect(text).toContain('café');
    expect(text).toContain('& more');
  });

  it('does not crash on out-of-range numeric entities', () => {
    const { text } = htmlToText('<body><p>bad &#x110000; entity</p></body>');
    expect(text).toContain('bad');
    expect(text).toContain('entity');
  });

  it('decodeXmlEntities keeps double-encoded text single-decoded', () => {
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeXmlEntities('&#65;&#x42;')).toBe('AB');
  });
});
