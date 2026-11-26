/**
 * Notices for third-party software shipped inside the app bundle (as opposed to the open-data
 * packs in OPEN_DATA_ATTRIBUTIONS). BSD-3-Clause clause 2 asks binary redistributions to
 * reproduce the copyright notice, conditions and disclaimer, so the full text is kept here and
 * in apps/web/public/THIRD-PARTY-NOTICES.txt (a test keeps the two in step).
 */
export interface ThirdPartyNotice {
  id: string;
  name: string;
  version: string;
  licenseName: string;
  usage: string;
  sourceUrl: string;
  copyright: string;
  /** License conditions and disclaimer, one paragraph per entry. */
  paragraphs: readonly string[];
}

/** The MIT License body (one paragraph per entry), shared by the MIT notices below. */
const MIT_PARAGRAPHS: readonly string[] = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
  'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
  'THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
];

export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[] = [
  {
    id: 'fsrs-browser',
    name: 'fsrs-browser (Open Spaced Repetition)',
    version: '6.6.0',
    licenseName: 'BSD-3-Clause',
    usage:
      'WebAssembly FSRS optimizer. It is loaded only when you run “Optimize weights” in deck settings.',
    sourceUrl: 'https://github.com/open-spaced-repetition/fsrs-browser',
    copyright: 'Copyright 2023 Alex Nguyen',
    paragraphs: [
      'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:',
      '1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.',
      '2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.',
      '3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.',
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS” AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
    ],
  },
  {
    id: 'sql.js',
    name: 'sql.js (SQLite compiled to WebAssembly)',
    version: '1.17.0',
    licenseName: 'MIT',
    usage:
      'Reads the SQLite collection inside Anki .apkg files. It is loaded only when you import an Anki package. SQLite itself is in the public domain.',
    sourceUrl: 'https://github.com/sql-js/sql.js',
    copyright: 'Copyright (c) 2017 sql.js authors (see AUTHORS)',
    paragraphs: MIT_PARAGRAPHS,
  },
  {
    id: 'fzstd',
    name: 'fzstd',
    version: '0.1.1',
    licenseName: 'MIT',
    usage:
      'Zstandard decompression for Anki packages from Anki 2.1.50 and later. It is loaded only when you import such a package.',
    sourceUrl: 'https://github.com/101arrowz/fzstd',
    copyright: 'Copyright (c) 2020 Arjun Barrett',
    paragraphs: MIT_PARAGRAPHS,
  },
  {
    id: 'uqr',
    name: 'uqr',
    version: '0.1.3',
    licenseName: 'MIT',
    usage:
      'Draws the add-device QR code in Settings > Cloud Sync. It is loaded only when that code is shown.',
    sourceUrl: 'https://github.com/unjs/uqr',
    copyright:
      'Copyright (c) Project Nayuki\nCopyright (c) 2023 Anthony Fu <https://github.com/antfu>',
    paragraphs: MIT_PARAGRAPHS,
  },
];
