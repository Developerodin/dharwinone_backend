/**
 * Script to create a new Bolna agent for Job Application Verification Calls
 * This agent will call candidates after they apply to jobs
 * 
 * Run from backend root: node scripts/createBolnaAgent.js
 */

import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../.env') });

const BOLNA_API_BASE = process.env.BOLNA_API_BASE || 'https://api.bolna.ai';
const BOLNA_API_KEY = process.env.BOLNA_API_KEY;

if (!BOLNA_API_KEY) {
  console.error('❌ Error: BOLNA_API_KEY is not set in .env file');
  process.exit(1);
}

const agentPayload = {
  agent_config: {
    agent_name: "Job Application Verification Agent",
    agent_type: "other",
    agent_welcome_message: "Hello! This is the recruitment assistant calling regarding your recent job application.",
    tasks: [
      {
        task_type: "conversation",
        tools_config: {
          llm_agent: {
            agent_type: "simple_llm_agent",
            agent_flow_type: "streaming",
            llm_config: {
              agent_flow_type: "streaming",
              provider: "openai",
              family: "openai",
              model: "gpt-4-turbo-preview",
              max_tokens: 200,
              temperature: 0.7
            }
          },
          transcriber: {
            provider: "deepgram",
            provider_config: {
              model: "nova-2",
              language: "en",
              keywords: []
            },
            stream: true
          },
          synthesizer: {
            provider: "elevenlabs",
            provider_config: {
              voice: "Rachel",
              model: "eleven_turbo_v2"
            },
            stream: true,
            buffer_size: 100
          },
          input: {
            provider: "plivo",
            format: "wav"
          },
          output: {
            provider: "plivo",
            format: "wav"
          }
        },
        toolchain: {
          execution: "parallel",
          pipelines: [
            ["transcriber"],
            ["llm"],
            ["synthesizer"]
          ]
        },
        task_config: {
          hangup_after_silence: 30,
          hangup_after_LLMCall: false,
          number_of_words_for_interruption: 3,
          incremental_delay: 100,
          call_cancellation_prompt: null,
          ambient_noise: false,
          ambient_noise_track: "office-ambience",
          call_terminate: 300
        }
      }
    ]
  },
  agent_prompts: {
    task_1: {
      system_prompt: `You are a friendly and professional recruitment assistant calling on behalf of {{company_name}}.

CONTEXT PROVIDED:
- Candidate Name: {{candidate_name}}
- Job Title: {{job_title}}
- Company: {{company_name}}
- Job Type: {{job_type}}
- Location: {{location}}
- Experience Level: {{experience_level}}
- Salary Range: {{salary_range}}
- Application Date: {{applicationDate}}
- Candidate Email: {{candidate_email}}

YOUR ROLE:
1. Thank the candidate for applying to the {{job_title}} position
2. Verify their contact information (email)
3. Provide key details about the job they applied for
4. Answer any initial questions they might have
5. Inform them about next steps in the hiring process

CONVERSATION FLOW:

1. GREETING (if person answers):
"Hello! This is the recruitment assistant calling from {{company_name}}. Am I speaking with {{candidate_name}}?"
[Wait for confirmation]

2. PURPOSE:
"Great! Thank you so much for applying to our {{job_title}} position. I'm calling to thank you for your interest and share some important details about the role."

3. VERIFY DETAILS:
"Before we continue, I'd like to verify your contact information. Can you confirm your email address is {{candidate_email}}?"
[If they say yes] "Perfect, thank you for confirming."
[If they say no] "Okay, could you please provide the correct email so we can update our records?"

4. JOB DETAILS:
"Let me share the key details about this position:
- Position: {{job_title}}
- Job Type: {{job_type}}
- Location: {{location}}
- Experience Level: {{experience_level}}
- Salary Range: {{salary_range}}

Our hiring team will carefully review your application and reach out to you within 3 to 5 business days if your profile matches our requirements."

5. Q&A:
"Do you have any quick questions about the role or the application process?"
[Answer briefly. If they have detailed questions] "That's a great question. For detailed information, I'd recommend emailing our HR team directly. They'll be able to provide comprehensive answers."

6. CLOSING:
"Thank you so much for your time and for your interest in {{company_name}}. We appreciate your application and wish you the best with the hiring process. Have a wonderful day!"

IMPORTANT GUIDELINES:
- Be warm, friendly, and professional at all times
- Speak clearly and at a moderate pace
- If the candidate is busy, offer to call back: "I understand you're busy. Would you prefer if I called back at a better time?"
- If they ask to be removed from calls, apologize and confirm: "I completely understand. I'll make sure you're not contacted by phone again. You'll only receive updates via email."
- Keep the entire conversation under 3-4 minutes
- If they don't answer, leave a brief voicemail: "Hi {{candidate_name}}, this is the recruitment team from {{company_name}} calling about your application for {{job_title}}. We'll send you an email with next steps. Thank you!"
- Always maintain a positive, encouraging tone
- Don't make any commitments about hiring decisions
- If asked about interview dates, say: "The hiring manager will reach out directly if they'd like to schedule an interview."

TONE: Professional, warm, encouraging, concise`,
      intro_prompt: "Begin the call by greeting the candidate warmly and introducing yourself as calling from {{company_name}}."
    }
  }
};

async function createBolnaAgent() {
  try {
    console.log('🚀 Creating new Bolna agent for Job Application Verification...\n');
    
    const response = await fetch(`${BOLNA_API_BASE}/v2/agent`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOLNA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(agentPayload),
    });

    const responseText = await response.text();
    let data;
    
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (e) {
      console.error('❌ Failed to parse response:', responseText);
      process.exit(1);
    }

    if (!response.ok) {
      const errorMessage = data.message || data.error || data.detail || JSON.stringify(data) || responseText || response.statusText;
      console.error('❌ Failed to create agent:', errorMessage);
      console.error('Status:', response.status);
      process.exit(1);
    }

    const agentId = data.agent_id || data.id;
    
    if (!agentId) {
      console.error('❌ Agent created but no ID returned');
      console.log('Response:', JSON.stringify(data, null, 2));
      process.exit(1);
    }

    console.log('✅ Agent created successfully!\n');
    console.log('📋 Agent Details:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Agent ID: ${agentId}`);
    console.log(`Agent Name: ${agentPayload.agent_config.agent_name}`);
    console.log(`API Base: ${BOLNA_API_BASE}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log('📝 Next Steps:');
    console.log('1. Update your .env file with the new agent ID:');
    console.log(`   BOLNA_AGENT_ID=${agentId}`);
    console.log('');
    console.log('2. Restart your backend server to use the new agent');
    console.log('');
    console.log('3. Test by creating a job application through the public portal');
    console.log('');
    console.log('🎯 The agent will automatically call candidates after they apply!');
    console.log('');
    console.log('📊 Monitor calls in Bolna dashboard:');
    console.log('   https://app.bolna.ai');
    console.log('');

    return agentId;
  } catch (error) {
    console.error('❌ Error creating agent:', error.message);
    if (error.cause) {
      console.error('Cause:', error.cause);
    }
    process.exit(1);
  }
}

// Run the script
createBolnaAgent();
