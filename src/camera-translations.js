import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z, id, parse, routeId } from './validation.js';
import { fail } from './security.js';

const language = z.enum(['vi','en','zh']);
const text = z.string().trim().min(1).max(6000);
const resultSchema = z.object({
  clientRequestId:id, sourceLanguage:language, targetLanguage:language,
  originalText:text, translatedText:text,
}).strict().refine(value=>value.sourceLanguage!==value.targetLanguage);
const fields = 'id,source_language,target_language,original_text,translated_text,created_at';
const present = row => ({
  id:row.id, sourceLanguage:row.source_language, targetLanguage:row.target_language,
  originalText:row.original_text, translatedText:row.translated_text,
  createdAt:new Date(row.created_at).toISOString(),
});

// Mounted behind requireAuth + requireActive. Every query is owner-scoped,
// including admin requests; camera results are not shared attendance records.
export function createCameraTranslations({pool,now=()=>new Date()}) {
  const router=Router();
  router.get('/camera-translations',async(req,res)=>{
    const {rows}=await pool.query(`SELECT ${fields} FROM camera_translations WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,[req.user.id]);
    res.json({data:rows.map(present)});
  });
  router.post('/camera-translations',async(req,res)=>{
    const input=parse(resultSchema,req.body);
    const lookup=`SELECT ${fields} FROM camera_translations WHERE user_id=$1 AND client_request_id=$2`;
    const key=[req.user.id,input.clientRequestId];
    const replay=row=>{
      if(!row||row.source_language!==input.sourceLanguage||row.target_language!==input.targetLanguage
        ||row.original_text!==input.originalText||row.translated_text!==input.translatedText)
        fail(409,'CAMERA_REQUEST_CONFLICT','Lần lưu trước có nội dung khác. Vui lòng tải lại lịch sử rồi thử lại.');
      return res.json({data:present(row)});
    };
    const previous=await pool.query(lookup,key);
    if(previous.rows[0])return replay(previous.rows[0]);
    const {rows}=await pool.query(`INSERT INTO camera_translations(id,user_id,client_request_id,source_language,target_language,original_text,translated_text,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,client_request_id) DO NOTHING RETURNING ${fields}`,
      [randomUUID(),req.user.id,input.clientRequestId,input.sourceLanguage,input.targetLanguage,input.originalText,input.translatedText,now()]);
    if(rows[0])return res.status(201).json({data:present(rows[0])});
    // A concurrent request may have won the unique key after the initial read.
    return replay((await pool.query(lookup,key)).rows[0]);
  });
  router.delete('/camera-translations/:id',async(req,res)=>{
    const {rows}=await pool.query('DELETE FROM camera_translations WHERE id=$1 AND user_id=$2 RETURNING id',[routeId(req),req.user.id]);
    if(!rows[0])fail(404,'NOT_FOUND','Không tìm thấy bản dịch đã lưu.');
    res.json({data:{deleted:true}});
  });
  return router;
}
