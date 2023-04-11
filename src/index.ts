/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `wrangler dev src/index.ts` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `wrangler publish src/index.ts --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import Twilio from 'twilio';

async function getPrimaryMessage(id, env, url){
    const response = new VoiceResponse();
	const gather = response.gather({action:url+"/voice/"+id+"/secondary.xml", method:"GET", numDigits:1, timeout:300});
	gather.say("Press any key to play the message")
	return new Response(response.toString(), {headers: {"Content-Type":"application/xml"}})
}

async function getSecondaryMessage(id, env){
	var text = await env.notifications.get("calls:"+id)
	const response = new VoiceResponse();
	for(let i = 0; i < 2; i++){
		response.say(text)
		response.pause({length:2})
		response.say("I repeat")
		response.pause({length:0.5})
	}
	response.say(text)
	await env.notifications.delete("calls:"+id)
	return new Response(response.toString(), {headers: {"Content-Type":"application/xml"}})
}

async function sendCall(text, env, base_url) {
    const call_id = ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    await env.notifications.put("calls:" + call_id, text);
    const sid = env.twilio_sid;
    const account = env.twilio_account;
    const url = `https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/${account}/Calls.json`;
    const token = env.twilio_token;
    let data = new URLSearchParams();
    data.append("Url", `${base_url}/voice/${call_id}/primary.xml`)
    data.append("Method", "GET")
    data.append("To", env.twilio_to)
    data.append("From", env.twilio_from)
    const login = Buffer.from(sid + ":" + token).toString("base64");
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${login}` }, body: data })
    return new Response()
}

async function processEmail(request, env){
    const data = await request.formData();
    const subject = data.get("subject")
    const envelope = JSON.parse(data.get("envelope"))
    await send_email([{ to: [{ email: env.sendgrid_contact }] }], `New message sent to ${envelope['to'][0]}`, `This message envelope is: ${JSON.stringify(envelope)}<br>This message subject is ${subject}<br><br>The message text is:<hr>${data.get("text")}<hr><br>The message body is:<hr>${data.get("html")}`, env)
    if (envelope['to'].toString() !== env.receiving_email_address.toString()) {
    	return new Response();
    }
    let contacts: object[] = [];
    for (let s in env.forward_emails) {
        contacts.push({ email:s });
    }
    await send_email([{to:contacts}], `New message sent to ${envelope['to'][0]}`, `This message subject is ${subject}<br><br>The message text is:<hr>${data.get("text")}<hr><br>The message body is:<hr>${data.get("html")}`, env)
    if (!subject.toUpperCase().includes("DOWN")) {
    	return new Response();
    }
    const time = Math.floor(Date.now() / 1000);
    var last_call = await env.notifications.get("last_call")
    if (last_call !== null && last_call !== undefined) {
        const last_time = parseInt(last_call)
        if((last_time+600) > time){
            return new Response("")
         }
    }
    await env.notifications.put("last_call", time.toString())
    await sendCall(subject, env, new URL(request.url).origin)
	return new Response("Processed")
}

async function send_email(receivers, subject, html, env) {
    const api_key = env.sendgrid_api_key;
    const url = `https://api.sendgrid.com/v3/mail/send`;
    const from = { email: env.sendgrid_from_email, name: env.application_name };
    const reply_to = { email: env.sendgrid_contact, name: env.application_name}
    const data = { personalizations: receivers, from: from, reply_to: reply_to, subject: subject, content: [{ type: "text/html", value: html }] }
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", authorization: `Bearer ${api_key}` }, body: JSON.stringify(data) })
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url)
		const path = url.pathname;
        if (path.startsWith("/parse_email")) {
        	if(!url.searchParams.has("key") || url.searchParams.get("key") !== env.key){
        		return new Response("Unauthorized")
        	}
            return await processEmail(request, env);
        }
        if (path.startsWith("/voice/")) {
            const key = path.split("/")[2];
            var call = await env.notifications.get("calls:"+key)
    		if (call === null || call === undefined) {
    			const response = new VoiceResponse();
				response.say("Invalid Call");
				return new Response(response.toString(), {headers: {"Content-Type":"application/xml"}})
			}
            if (path.endsWith("primary.xml")) {
                return await getPrimaryMessage(key, env, url.origin);
            } else if (path.endsWith("secondary.xml")) {
                return await getSecondaryMessage(key, env);
            }
    		const response = new VoiceResponse();
			response.say("Invalid Request");
			return new Response(response.toString(), {headers: {"Content-Type":"application/xml"}})
        }
		return new Response();
	},
};
