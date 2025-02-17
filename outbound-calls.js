import WebSocket from "ws";
import Twilio from "twilio";

export function registerOutboundRoutes(fastify) {
  // Check for required environment variables
  const { 
    ELEVENLABS_API_KEY, 
    ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER
  } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error("Missing required environment variables");
    throw new Error("Missing required environment variables");
  }

  // Initialize Twilio client
  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // Helper function to get signed URL for authenticated conversations
  async function getSignedUrl() {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get signed URL: ${response.statusText}`);
      }

      const data = await response.json();
      return data.signed_url;
    } catch (error) {
      console.error("Error getting signed URL:", error);
      throw error;
    }
  }

  // Route to initiate outbound calls
  fastify.post("/outbound-call", async (request, reply) => {
    const { number, prompt, firstMessage,webhook, externalId } = request.body;

    console.log(webhook)
    if (!number) {
      return reply.code(400).send({ error: "Phone number is required" });
    }

    try {
      // Cria a URL para o TwiML
      const guid = externalId;
      const twimlUrl = new URL(`https://${request.headers.host}/outbound-call-twiml`);
      twimlUrl.searchParams.append('prompt', prompt || '');
      twimlUrl.searchParams.append('firstMessage', firstMessage || '');
      twimlUrl.searchParams.append('webhook', webhook || '');
      twimlUrl.searchParams.append('id', guid || '');


      // Inicia a chamada com o Twilio
      const call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: number,
        url: twimlUrl.toString()
      });

      reply.send({ 
        success: true, 
        message: "Call initiated",
        externalId: guid, 
        callSid: call.sid 
      });
    } catch (error) {
      console.error("Error initiating outbound call:", error);
      reply.code(500).send({ 
        success: false, 
        error: "Failed to initiate call" 
      });
    }
  });

  // TwiML route for outbound calls
  fastify.all("/outbound-call-twiml", async (request, reply) => {
    const prompt = request.query.prompt || '';
    const firstMessage = request.query.firstMessage || ''; 
    const webhook = request.query.webhook || '';
    const id = request.query.id || ''; 

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="firstMessage" value="${firstMessage}" />
            <Parameter name="webhook" value="${webhook}" />
            <Parameter name="id" value="${id}" />
          </Stream>
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling media streams
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let conversationId = null;
      let elevenLabsWs = null;
      let customParameters = null;  // Add this to store parameters
      let webhook = null;
      let externalId = null;
      let conversationHistory = [];

      // Handle WebSocket errors
      ws.on('error', console.error);
 
    // Function to send webhook without axios
    const sendWebhook = async (event, data) => {
      console.log('URL WEBHOOK');
      console.log(webhook);
      if (customParameters?.webhook) {
        try {
          const response = await fetch(customParameters.webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event, ...data })
          });
          if (response.ok) {
            console.log(`[Webhook] Sent event: ${event}`);
          } else {
            console.error("[Webhook] Failed to send webhook:", response.statusText);
          }
        } catch (error) {
          console.error("[Webhook] Error sending webhook:", error);
        }
      }
    };

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Send initial configuration with prompt and first message
            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: { prompt: customParameters?.prompt},
                  first_message: customParameters?.firstMessage,
                },
              }
            };

            console.log("[ElevenLabs] Sending initial config with prompt:", initialConfig.conversation_config_override.agent.prompt.prompt);

            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  if (message.conversation_initiation_metadata_event?.conversation_id) {
                    conversationId = message.conversation_initiation_metadata_event.conversation_id;
                  }
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk
                        }
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64
                        }
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log("[ElevenLabs] Received audio but no StreamSid yet");
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({ 
                      event: "clear",
                      streamSid 
                    }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id
                    }));
                  }
                  break;
                case 'user_transcript':
                  const userText = {
                    role: "Cliente",
                    text: message.user_transcription_event?.user_transcript || "Sem texto"
                  };
                  conversationHistory.push(userText);
                  console.log(`[User] ${message.user_transcription_event.user_transcript}`);
                  break;
                case 'agent_response':
                  const agentText = {
                    role: "Atendente",
                    text: message.agent_response_event?.agent_response || "Sem texto"
                  };
                  conversationHistory.push(agentText);
                  console.log(`[Agent] ${message.agent_response_event.agent_response}`);
                  break;

                default:
                  console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
              sendWebhook("error", { externalId, error: error.message, conversationHistory });
            }
          });
  
          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
            sendWebhook("error", { externalId, error: error.message, conversationHistory });
          });
  
          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
            sendWebhook("call_ended", { externalId, callSid, conversationId, conversationHistory });
            
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
          sendWebhook("error", { externalId, error: error.message, conversationHistory });
        }
      };

      // Set up ElevenLabs connection
      setupElevenLabs();

      // Handle messages from Twilio
      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;  // Store parameters
              console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              console.log('[Twilio] Start parameters:', customParameters);
              webhook = customParameters?.webhook;
              externalId = customParameters?.id;
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    });
  });

  fastify.post("/webhook", async (request, reply) => {
    try {
      const eventData = request.body;
      console.log("[Webhook] Received event:", eventData);
      reply.send({ success: true });
    } catch (error) {
      console.error("[Webhook] Error processing event:", error);
      reply.status(500).send({ success: false, error: error.message });
    }
  });
}
