const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { Resend } = require('resend');

// --- CONSTANTS ---

const VOICE_RULES = `You are writing as Shreyas Bharadwaj, a public policy consultant based in India. He works across four lanes: policy research, political strategy, intellectual history, and content production. The range is the point; each lane feeds the others.

What he offers:
- Political framing of policy: connecting policy to political consequence. What a reform means for coalitions, for voter segments, for the narrative. Bureaucrats produce policy briefs; Shreyas connects policy to political consequence.
- Long-horizon thinking: structural risks and opportunities that surface in the cycle after the next election. Early warning, not post-mortems. He flags risks and opportunities no one has asked about yet.
- Intellectual architecture: political theory, developmental economics, constitutional history turned into strategy notes, positioning briefs, and published arguments. Frameworks pressure-tested against Indian political reality, not imported templates.
- Production across registers: a polemical essay and a fiscal federalism briefer require different voices. He produces both without mixing registers. The right output in the right format for the right audience.

Engagement models: project-based or retainer, remote or embedded. Retainer engagements start at 3L/month for focused advisory. Project-based work starts at 5L depending on scope and timeline. For clients with budget below 1L/month, suggest a scoped, time-bound engagement rather than ongoing advisory.

Voice rules:
- Long build, short kill: build cumulative force with clause-heavy sentences, then land the verdict in a short declarative.
- Colons as pivots, semicolons as chains. Never use em dashes.
- State, don't hedge. No "I think," no "it could be argued." Every piece has a position. Take it.
- Specificity is authority: name the person, cite the number, state the source.
- Evidence before thesis: earn your conclusion before stating it. Support claims with a specific detail, then land the point.
- Orwell's rules: short words over long, cut what can be cut, active voice always. Never use a metaphor you've seen in print.
- No AI-sounding language. No "Great question!" No filler, no caveats.
- No markdown, no headers, no bold, no bullet markers, no asterisks. Plain text only.

Lead scoring (use this to calibrate proposal tone and investment section):
- HIGH (pursue immediately, two or more signals): client needs the policy-politics intersection; government or party-adjacent client; time-bound political trigger (election, legislative session, budget cycle); budget 3L+/month retainer or 5L+ project; needs both research AND strategy/communications.
- MEDIUM (qualify further): policy research only without political framing need; think tanks, NGOs, corporate government affairs; content production without strategy; budget 1-3L/month; general "policy consulting" interest without specific problem.
- LOW (respond but deprioritise): academic research assistance; no budget AND vague scope; "content writer" framing; no India connection; mentorship requests; one-off social media/PR.
- Scoring rule: budget alone does not determine score. A 5L/month client wanting generic thought leadership is MEDIUM. A 2L/month client from a CM's office needing coalition analysis before a by-election is HIGH. The qualifying question: does this client need the policy-politics intersection, or just one side?`;

const RESEARCH_PROMPT = `You are a research analyst preparing background for a consulting proposal. Given the client details below, produce a 150-word research brief covering:
1. Industry context and current dynamics
2. Typical challenges for organizations at this stage
3. Relevant trends or structural shifts that affect their situation

Be specific and analytical. No platitudes. If you don't know something, say so rather than inventing.

${VOICE_RULES}`;

const SECTION_CONSTRAINTS = {
    understanding: 'Write 2-3 sentences restating the client\'s situation and challenge in your own words. Show you understood what they actually said. Reference their specific details, not generic versions of their problem.',
    diagnosis: 'Write 3-4 sentences identifying the core problem beneath the stated challenge. This is where you demonstrate insight: what the client might not see about their own situation. Be pointed.',
    approach: 'Write 4-6 sentences on how you would tackle this. Be specific about methods: what kind of research, what deliverables, what sequence. No vague "we will leverage" language.',
    deliverables: 'Write 3-5 concrete deliverables. Each on its own line. Format: "Deliverable name: one-sentence description" (use a colon separator). These must be specific to this client, not generic consulting outputs.',
    timeline: 'Write 2-3 sentences on phasing and duration. Be concrete about what happens when.',
    investment: 'Write 1-2 sentences referencing the client\'s stated budget and how you would structure fees. Retainer engagements start at 3L/month; project-based work starts at 5L. If the client\'s budget is below these floors, suggest a scoped, time-bound engagement. If budget is vague, suggest a scoping call. Use the lead score from context to calibrate: HIGH leads get specific pricing; MEDIUM leads get a range; LOW leads get redirected to a scoping conversation.',
};

const DRAFT_PROMPT = `You are Shreyas Bharadwaj writing one section of a consulting proposal. Ground the proposal in your actual services: political framing of policy, long-horizon thinking, intellectual architecture, and production across registers. Recommend what fits the client's situation; do not offer all four by default.

${VOICE_RULES}

Write ONLY the section requested. No section headers, no labels, no prefixes. Just the content.`;

const REVIEW_PROMPT = `You are a ruthless editor reviewing a consulting proposal written in Shreyas Bharadwaj's voice. Your job is to find problems. If you say ALL_CLEAR when issues exist, the proposal ships weak and the client sees generic work.

${VOICE_RULES}

Evaluate each section against three criteria:
1. VOICE: Is it direct, specific, and in Shreyas's style? Or does it hedge, use filler, or sound like a template?
2. SPECIFICITY: Does it reference the client's actual situation, or could this paragraph appear in any proposal?
3. PERSUASION: Does it build a case, or just state facts?

For each section that needs revision, output exactly:
REVISE section_name: one-sentence note explaining what to fix

If a section is strong, skip it. If everything is genuinely strong, output exactly: ALL_CLEAR

Valid section names: understanding, diagnosis, approach, deliverables, timeline, investment`;

const SECTION_MAP = [
    { key: 'understanding', title: 'Understanding' },
    { key: 'diagnosis', title: 'Diagnosis' },
    { key: 'approach', title: 'Approach' },
    { key: 'deliverables', title: 'Deliverables' },
    { key: 'timeline', title: 'Timeline & Phasing' },
    { key: 'investment', title: 'Investment' },
];

// Single-call fallback prompt (original approach, used if agent loop fails)
const FALLBACK_PROMPT = `You are Shreyas Bharadwaj writing a consulting proposal. Based on the client intake below, produce a tailored proposal.

${VOICE_RULES}

Write the proposal in these exact sections, separated by |||SECTION|||. No markdown. Plain text only.

1. UNDERSTANDING: 2-3 sentences restating the client's situation.
2. DIAGNOSIS: 3-4 sentences on the core problem beneath the stated challenge.
3. APPROACH: 4-6 sentences on how you would tackle this.
4. DELIVERABLES: 3-5 concrete deliverables, each as "Name: description" on its own line.
5. TIMELINE: 2-3 sentences on phasing.
6. INVESTMENT: 1-2 sentences referencing the budget.`;


// --- SANITIZE FOR PDF ---

function sanitizeForPdf(text) {
    if (!text) return '';
    return text
        // Smart quotes → straight quotes
        .replace(/[\u2018\u2019\u201A]/g, "'")
        .replace(/[\u201C\u201D\u201E]/g, '"')
        // Dashes → double hyphen
        .replace(/[\u2013\u2014\u2015]/g, '--')
        // Ellipsis → three dots
        .replace(/\u2026/g, '...')
        // Special spaces → regular space
        .replace(/[\u00A0\u2002\u2003\u2009]/g, ' ')
        // Bullet → hyphen
        .replace(/\u2022/g, '-')
        // Strip anything outside printable ASCII + Latin-1 Supplement (WinAnsi safe)
        .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}


// --- LLM HELPER ---

async function callLLM(systemPrompt, userMessage, apiKey, referer, options = {}) {
    const messages = [{ role: 'system', content: systemPrompt }];

    if (Array.isArray(userMessage)) {
        messages.push(...userMessage);
    } else {
        messages.push({ role: 'user', content: userMessage });
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': referer,
        },
        body: JSON.stringify({
            model: 'anthropic/claude-sonnet-4-6',
            messages,
            max_tokens: options.max_tokens || 400,
            temperature: options.temperature ?? 0.5,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}


// --- TOOL 1: RESEARCH CLIENT ---

async function researchClient(intakeData, apiKey, referer) {
    const prompt = [
        `Company: ${intakeData.company || 'Not specified'}`,
        `Challenge: ${intakeData.challenge || 'Not specified'}`,
        `What they've tried: ${intakeData.tried || 'Not specified'}`,
        `Success looks like: ${intakeData.success || 'Not specified'}`,
        `Budget: ${intakeData.budget || 'Not specified'}`,
    ].join('\n');

    try {
        const result = await callLLM(RESEARCH_PROMPT, prompt, apiKey, referer, {
            max_tokens: 400,
            temperature: 0.4,
        });
        console.log('[Agent] research_client: done');
        return result;
    } catch (err) {
        console.error('[Agent] research_client failed:', err.message);
        return 'Research unavailable. Proceeding with intake data only.';
    }
}


// --- TOOL 2: DRAFT SECTION ---

async function draftSection(sectionName, context, apiKey, referer, revisionNote) {
    const constraints = SECTION_CONSTRAINTS[sectionName];
    if (!constraints) throw new Error(`Unknown section: ${sectionName}`);

    const parts = [
        `SECTION TO WRITE: ${sectionName.toUpperCase()}`,
        `CONSTRAINTS: ${constraints}`,
        '',
        '--- CLIENT INTAKE ---',
        `Company: ${context.intakeData.company || 'Not specified'}`,
        `Challenge: ${context.intakeData.challenge || 'Not specified'}`,
        `What they've tried: ${context.intakeData.tried || 'Not specified'}`,
        `Success looks like: ${context.intakeData.success || 'Not specified'}`,
        `Budget: ${context.intakeData.budget || 'Not specified'}`,
    ];

    if (context.research) {
        parts.push('', '--- RESEARCH BRIEF ---', context.research);
    }

    // Include previously drafted sections for coherence
    const draftedKeys = Object.keys(context.sections);
    if (draftedKeys.length > 0) {
        parts.push('', '--- PREVIOUSLY DRAFTED SECTIONS ---');
        for (const key of draftedKeys) {
            parts.push(`[${key.toUpperCase()}]`, context.sections[key], '');
        }
    }

    if (revisionNote) {
        parts.push('', `--- REVISION NOTE (address this) ---`, revisionNote);
    }

    try {
        let result = await callLLM(DRAFT_PROMPT, parts.join('\n'), apiKey, referer, {
            max_tokens: 350,
            temperature: 0.6,
        });
        // Strip any leading section label the LLM might include
        result = result.replace(/^(?:UNDERSTANDING|DIAGNOSIS|APPROACH|DELIVERABLES|TIMELINE(?:\s*&\s*PHASING)?|INVESTMENT)\s*:\s*/i, '');
        console.log(`[Agent] draft_section(${sectionName}): done${revisionNote ? ' (revised)' : ''}`);
        return result;
    } catch (err) {
        console.error(`[Agent] draft_section(${sectionName}) failed:`, err.message);
        // Retry once
        try {
            const result = await callLLM(DRAFT_PROMPT, parts.join('\n'), apiKey, referer, {
                max_tokens: 350,
                temperature: 0.6,
            });
            return result;
        } catch (retryErr) {
            console.error(`[Agent] draft_section(${sectionName}) retry failed:`, retryErr.message);
            return `[Section could not be generated. Contact shreyas1223@gmail.com for the full proposal.]`;
        }
    }
}


// --- TOOL 3: REVIEW PROPOSAL ---

async function reviewProposal(context, apiKey, referer) {
    const parts = [
        '--- CLIENT INTAKE (for reference) ---',
        `Company: ${context.intakeData.company || 'Not specified'}`,
        `Challenge: ${context.intakeData.challenge || 'Not specified'}`,
        '',
        '--- FULL PROPOSAL DRAFT ---',
    ];

    for (const { key } of SECTION_MAP) {
        parts.push(`[${key.toUpperCase()}]`, context.sections[key] || '(missing)', '');
    }

    parts.push('Review each section now. Be critical.');

    try {
        const result = await callLLM(REVIEW_PROMPT, parts.join('\n'), apiKey, referer, {
            max_tokens: 400,
            temperature: 0.3,
        });
        console.log('[Agent] review_proposal: done');
        return result;
    } catch (err) {
        console.error('[Agent] review_proposal failed:', err.message);
        return 'ALL_CLEAR'; // graceful degradation: skip review
    }
}

function parseRevisionNotes(reviewResult) {
    const notes = [];
    const lines = reviewResult.split('\n');
    for (const line of lines) {
        const match = line.match(/^REVISE\s+(\w+):\s*(.+)$/i);
        if (match) {
            const name = match[1].toLowerCase();
            if (SECTION_MAP.some(s => s.key === name)) {
                notes.push({ name, note: match[2].trim() });
            }
        }
    }
    return notes;
}


// --- AGENT LOOP (hybrid orchestration) ---

async function runAgentLoop(intakeData, conversation, apiKey, referer) {
    const startTime = Date.now();
    const context = { intakeData, conversation, research: null, sections: {} };

    // Phase 1: Research (1 LLM call)
    console.log('[Agent] Phase 1: Researching client...');
    context.research = await researchClient(intakeData, apiKey, referer);

    // Phase 2: Draft all 6 sections sequentially (6 LLM calls)
    console.log('[Agent] Phase 2: Drafting sections...');
    for (const { key } of SECTION_MAP) {
        if (Date.now() - startTime > 55000) {
            console.log('[Agent] Timeout approaching, stopping drafts');
            break;
        }
        context.sections[key] = await draftSection(key, context, apiKey, referer);
    }

    // Phase 3: Review loop, max 2 iterations
    console.log('[Agent] Phase 3: Review loop...');
    for (let rev = 0; rev < 2; rev++) {
        if (Date.now() - startTime > 55000) {
            console.log('[Agent] Timeout approaching, skipping review');
            break;
        }

        const reviewResult = await reviewProposal(context, apiKey, referer);

        if (reviewResult.trim() === 'ALL_CLEAR') {
            console.log(`[Agent] Review ${rev + 1}: ALL_CLEAR`);
            break;
        }

        const sectionsToRevise = parseRevisionNotes(reviewResult);
        if (sectionsToRevise.length === 0) {
            console.log(`[Agent] Review ${rev + 1}: no parseable revisions, treating as ALL_CLEAR`);
            break;
        }

        console.log(`[Agent] Review ${rev + 1}: revising ${sectionsToRevise.map(s => s.name).join(', ')}`);
        for (const section of sectionsToRevise) {
            if (Date.now() - startTime > 55000) break;
            context.sections[section.name] = await draftSection(
                section.name, context, apiKey, referer, section.note
            );
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const callCount = 1 + Object.keys(context.sections).length + 1; // research + drafts + review (minimum)
    console.log(`[Agent] Complete in ${elapsed}s (~${callCount}+ LLM calls)`);

    return context.sections;
}


// --- SINGLE-CALL FALLBACK ---

async function fallbackGenerate(intakeData, apiKey, referer) {
    console.log('[Fallback] Using single-call generation');
    const prompt = FALLBACK_PROMPT + `\n\nCLIENT INTAKE:\nCompany: ${intakeData.company || 'Not specified'}\nChallenge: ${intakeData.challenge || 'Not specified'}\nWhat they've tried: ${intakeData.tried || 'Not specified'}\nSuccess looks like: ${intakeData.success || 'Not specified'}\nBudget: ${intakeData.budget || 'Not specified'}\nEmail: ${intakeData.email}`;

    const content = await callLLM(prompt, 'Write the proposal now.', apiKey, referer, {
        max_tokens: 1200,
        temperature: 0.6,
    });

    const parts = content.split('|||SECTION|||').map(s => s.trim()).filter(Boolean);
    const sections = {};
    SECTION_MAP.forEach(({ key }, i) => {
        // Strip any leading section label the LLM might include (e.g. "UNDERSTANDING: ...")
        let text = parts[i] || '';
        text = text.replace(/^(?:UNDERSTANDING|DIAGNOSIS|APPROACH|DELIVERABLES|TIMELINE(?:\s*&\s*PHASING)?|INVESTMENT)\s*:\s*/i, '');
        sections[key] = text;
    });
    return sections;
}


// --- PDF RENDERING ---

async function renderPdf(sections, intakeData) {
    const pdfDoc = await PDFDocument.create();
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 595.28;  // A4
    const pageHeight = 841.89;
    const margin = 65;
    const contentWidth = pageWidth - margin * 2;

    const dark = rgb(0.1, 0.1, 0.09);
    const accent = rgb(0.64, 0.48, 0.12);
    const mid = rgb(0.29, 0.29, 0.27);
    const light = rgb(0.48, 0.48, 0.45);

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    function addPage() {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
    }

    function checkSpace(needed) {
        if (y - needed < margin) addPage();
    }

    function drawLine(x1, yPos, x2, color, thickness) {
        page.drawLine({
            start: { x: x1, y: yPos },
            end: { x: x2, y: yPos },
            thickness: thickness || 0.5,
            color: color || light,
        });
    }

    function wrapText(text, font, fontSize, maxWidth) {
        const words = text.split(' ');
        const lines = [];
        let currentLine = '';
        for (const word of words) {
            const test = currentLine ? currentLine + ' ' + word : word;
            const width = font.widthOfTextAtSize(test, fontSize);
            if (width > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = test;
            }
        }
        if (currentLine) lines.push(currentLine);
        return lines;
    }

    function drawWrapped(text, font, fontSize, color, lineHeight) {
        const paragraphs = text.split('\n').filter(p => p.trim());
        for (const para of paragraphs) {
            const lines = wrapText(para.trim(), font, fontSize, contentWidth);
            for (const line of lines) {
                checkSpace(lineHeight);
                page.drawText(line, { x: margin, y, size: fontSize, font, color });
                y -= lineHeight;
            }
            y -= lineHeight * 0.3;
        }
    }

    // --- HEADER ---
    page.drawText('SHREYAS BHARADWAJ', {
        x: margin, y, size: 9, font: helveticaBold, color: accent,
    });
    y -= 14;
    page.drawText('Policy Consultant', {
        x: margin, y, size: 8, font: helvetica, color: light,
    });

    const dateStr = new Date().toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric',
    });
    const dateWidth = helvetica.widthOfTextAtSize(dateStr, 8);
    page.drawText(dateStr, {
        x: pageWidth - margin - dateWidth, y: y + 14,
        size: 8, font: helvetica, color: light,
    });

    y -= 20;
    drawLine(margin, y, pageWidth - margin, accent, 1.5);
    y -= 35;

    // --- TITLE ---
    page.drawText('Consulting Proposal', {
        x: margin, y, size: 22, font: helveticaBold, color: dark,
    });
    y -= 18;

    const clientLabel = 'Prepared for: ' + (intakeData.company || intakeData.email);
    page.drawText(clientLabel, {
        x: margin, y, size: 10, font: helvetica, color: mid,
    });
    y -= 40;

    drawLine(margin, y, pageWidth - margin, light, 0.5);
    y -= 30;

    // --- SECTIONS ---
    for (let i = 0; i < SECTION_MAP.length; i++) {
        const { key, title } = SECTION_MAP[i];
        const body = sanitizeForPdf(sections[key] || '');

        checkSpace(60);

        const numStr = String(i + 1).padStart(2, '0');
        page.drawText(numStr, {
            x: margin, y, size: 9, font: helveticaBold, color: accent,
        });
        page.drawText(title.toUpperCase(), {
            x: margin + 22, y, size: 9, font: helveticaBold, color: dark,
        });
        y -= 8;
        drawLine(margin, y, margin + 80, accent, 0.75);
        y -= 16;

        drawWrapped(body, helvetica, 9.5, mid, 14);
        y -= 16;
    }

    // --- FOOTER ---
    checkSpace(60);
    y -= 10;
    drawLine(margin, y, pageWidth - margin, light, 0.5);
    y -= 20;

    page.drawText('shreyas1223@gmail.com', {
        x: margin, y, size: 8, font: helvetica, color: accent,
    });
    page.drawText('linkedin.com/in/shreyas-bharadwaj', {
        x: margin + 160, y, size: 8, font: helvetica, color: light,
    });

    return pdfDoc.save();
}


// --- HANDLER ---

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { intake_data, conversation } = req.body;

    if (!intake_data || !intake_data.email) {
        return res.status(400).json({ error: 'Intake data with email is required' });
    }

    console.log('=== NEW PROPOSAL REQUEST ===');
    console.log('Company:', intake_data.company);
    console.log('Challenge:', intake_data.challenge);
    console.log('Email:', intake_data.email);
    console.log('============================');

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'API key not configured' });
    }

    const referer = req.headers?.referer || 'http://localhost:3000';

    try {
        // Try agentic loop first
        let sections;
        try {
            sections = await runAgentLoop(intake_data, conversation, apiKey, referer);

            // Verify we got all sections
            const missing = SECTION_MAP.filter(s => !sections[s.key] || sections[s.key].length < 10);
            if (missing.length > 0) {
                console.log(`[Agent] Missing/thin sections: ${missing.map(s => s.key).join(', ')}. Falling back.`);
                sections = await fallbackGenerate(intake_data, apiKey, referer);
            }
        } catch (agentErr) {
            console.error('[Agent] Loop failed, using fallback:', agentErr.message);
            sections = await fallbackGenerate(intake_data, apiKey, referer);
        }

        // Render PDF
        const pdfBytes = await renderPdf(sections, intake_data);
        const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
        const filename = 'Shreyas-Bharadwaj-Proposal.pdf';

        // Email the proposal to the client
        const resendKey = process.env.RESEND_API_KEY;
        if (resendKey && intake_data.email) {
            try {
                const resend = new Resend(resendKey);
                await resend.emails.send({
                    from: 'Shreyas Bharadwaj <onboarding@resend.dev>',
                    to: intake_data.email,
                    subject: 'Your Consulting Proposal from Shreyas Bharadwaj',
                    text: [
                        `Hi,`,
                        ``,
                        `Thank you for your interest. Attached is a consulting proposal tailored to your situation.`,
                        ``,
                        `If you'd like to discuss scope, timeline, or next steps, reply to this email or reach out at shreyas1223@gmail.com.`,
                        ``,
                        `Shreyas Bharadwaj`,
                        `Policy Consultant`,
                        `linkedin.com/in/shreyas-bharadwaj`,
                    ].join('\n'),
                    attachments: [
                        {
                            filename,
                            content: pdfBase64,
                        },
                    ],
                });
                console.log(`[Email] Proposal sent to ${intake_data.email}`);
            } catch (emailErr) {
                console.error('[Email] Failed to send:', emailErr.message);
                // Non-blocking: PDF still returned even if email fails
            }
        } else if (!resendKey) {
            console.log('[Email] RESEND_API_KEY not set, skipping email delivery');
        }

        return res.json({
            success: true,
            pdf: pdfBase64,
            filename,
        });
    } catch (err) {
        console.error('Proposal generation error:', err);
        return res.status(500).json({ error: 'Failed to generate proposal' });
    }
};
