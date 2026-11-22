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
];

/** Plain-text rendering, as it appears in THIRD-PARTY-NOTICES.txt. */
export function formatThirdPartyNotice(notice: ThirdPartyNotice): string {
  return [
    `${notice.name} ${notice.version}: ${notice.licenseName}`,
    `Source: ${notice.sourceUrl}`,
    '',
    notice.copyright,
    '',
    notice.paragraphs.join('\n\n'),
  ].join('\n');
}
