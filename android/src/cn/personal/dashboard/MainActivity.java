package cn.personal.dashboard;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.*;
import android.widget.EditText;
import android.widget.FrameLayout;
import org.json.*;
import org.w3c.dom.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import javax.xml.parsers.DocumentBuilderFactory;
import okhttp3.*;

/** A local-only WebView. Remote pages NEVER load in this bridged WebView. */
public class MainActivity extends Activity {
    private static final String HOME="https://appassets.androidplatform.net/assets/index.html";
    private static final String BASE="https://dav.jianguoyun.com/dav/";
    private static final int LIMIT=15*1024*1024, IMPORT=11, EXPORT=12;
    private static final String KEY="personal-dashboard-sync-v1";
    private WebView web;
    private FrameLayout frame;
    private AtomicFile local;
    private final Object storageLock=new Object();
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final OkHttpClient http=new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(20,TimeUnit.SECONDS).readTimeout(25,TimeUnit.SECONDS).writeTimeout(25,TimeUnit.SECONDS).callTimeout(35,TimeUnit.SECONDS).build();
    private ValueCallback<Uri[]> fileCallback;
    private String exportID, exportText;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        local=new AtomicFile(new File(getFilesDir(),"offline-state.json"));
        frame=new FrameLayout(this);web=new WebView(this);
        frame.addView(web,new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,FrameLayout.LayoutParams.MATCH_PARENT));
        // One owner for system / gesture / keyboard insets. The WebView receives
        // the remaining content area; CSS must not also guess navigation-bar sizes.
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if(Build.VERSION.SDK_INT>=30)getWindow().setDecorFitsSystemWindows(false);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE|View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN|View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        frame.setOnApplyWindowInsetsListener((v,insets)->{
            if(Build.VERSION.SDK_INT>=30){
                android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout()|WindowInsets.Type.ime());
                android.graphics.Insets gestures=insets.getInsets(WindowInsets.Type.mandatorySystemGestures());
                v.setPadding(bars.left,bars.top,bars.right,Math.max(bars.bottom,gestures.bottom));
                return WindowInsets.CONSUMED;
            }
            int left=insets.getSystemWindowInsetLeft(),top=insets.getSystemWindowInsetTop(),right=insets.getSystemWindowInsetRight(),bottom=insets.getSystemWindowInsetBottom();
            if(Build.VERSION.SDK_INT>=28 && insets.getDisplayCutout()!=null){
                android.view.DisplayCutout cutout=insets.getDisplayCutout();
                left=Math.max(left,cutout.getSafeInsetLeft());top=Math.max(top,cutout.getSafeInsetTop());
                right=Math.max(right,cutout.getSafeInsetRight());bottom=Math.max(bottom,cutout.getSafeInsetBottom());
            }
            if(Build.VERSION.SDK_INT>=29)bottom=Math.max(bottom,insets.getMandatorySystemGestureInsets().bottom);
            v.setPadding(left,top,right,bottom);
            WindowInsets consumed=insets.consumeSystemWindowInsets().consumeStableInsets();
            return Build.VERSION.SDK_INT>=28?consumed.consumeDisplayCutout():consumed;
        });
        setContentView(frame);
        frame.post(()->frame.requestApplyInsets());
        WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(false);s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSafeBrowsingEnabled(true);
        WebView.setWebContentsDebuggingEnabled(false);
        CookieManager.getInstance().setAcceptCookie(false);
        web.addJavascriptInterface(new Bridge(),"DashboardNative");
        web.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest request){
                Uri uri=request.getUrl();String path=uri.getPath();
                if("https".equals(uri.getScheme())&&"appassets.androidplatform.net".equals(uri.getHost())&&path!=null&&path.startsWith("/assets/")) {
                    String name=path.substring(8);
                    if(Arrays.asList("index.html","app.js","style.css","sync-core.js","sync-client.js","sync-ui.js","moments.js").contains(name)) {
                        try {
                            String mime=name.endsWith(".html")?"text/html":name.endsWith(".css")?"text/css":"application/javascript";
                            Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");
                            headers.put("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
                            return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,getAssets().open(name));
                        } catch(IOException ignored){}
                    }
                }
                return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r) {
                if(HOME.equals(r.getUrl().toString()))return false;
                if(r.isForMainFrame())openExternal(r.getUrl());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> callback,FileChooserParams p) {
                if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;
                Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                boolean photo=Arrays.stream(p.getAcceptTypes()).anyMatch(type->type.startsWith("image/"));
                if(photo){
                    i.setType("image/*");
                    i.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/jpeg","image/png","image/webp"});
                } else {
                    i.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"application/json","text/plain","application/octet-stream"});
                }
                try{startActivityForResult(i,IMPORT);}catch(Exception e){fileCallback.onReceiveValue(null);fileCallback=null;}return true;
            }
            @Override public boolean onJsAlert(WebView v,String u,String message,JsResult result){
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定",(d,w)->result.confirm()).setOnCancelListener(d->result.cancel()).show();return true;
            }
            @Override public boolean onJsConfirm(WebView v,String u,String message,JsResult result){
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定",(d,w)->result.confirm()).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;
            }
            @Override public boolean onJsPrompt(WebView v,String u,String message,String value,JsPromptResult result){
                EditText input=new EditText(MainActivity.this);input.setText(value);
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setView(input).setPositiveButton("确定",(d,w)->result.confirm(input.getText().toString())).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;
            }
        });
        web.loadUrl(HOME);
    }
    private void openExternal(Uri uri){
        if(!"https".equals(uri.getScheme())&&!"http".equals(uri.getScheme()))return;
        try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception ignored){}
    }
    @Override public void onBackPressed(){
        web.evaluateJavascript("(()=>{const m=document.getElementById('modalOverlay');if(m&&!m.hidden){closeModal();return true;}return false;})()",v->{if(!"true".equals(v))moveTaskToBack(true);});
    }
    @Override protected void onPause(){
        if(web!=null){web.evaluateJavascript("window.dashboardForeground=false",null);web.onPause();}super.onPause();
    }
    @Override protected void onResume(){
        super.onResume();if(web!=null){web.onResume();web.evaluateJavascript("window.dashboardForeground=true;window.dispatchEvent(new Event('dashboard-resume'))",null);}
    }
    @Override protected void onDestroy(){
        if(fileCallback!=null)fileCallback.onReceiveValue(null);
        worker.shutdown();if(web!=null){web.removeJavascriptInterface("DashboardNative");web.destroy();web=null;}super.onDestroy();
    }
    private JSONObject ok(Object value) throws JSONException{return new JSONObject().put("ok",true).put("value",value==null?JSONObject.NULL:value);}
    private JSONObject error(String message){try{return new JSONObject().put("ok",false).put("error",message);}catch(JSONException e){throw new RuntimeException(e);}}
    private void reply(String id,JSONObject response){
        runOnUiThread(()->{if(web!=null)web.evaluateJavascript("window.dashboardNativeReply&&window.dashboardNativeReply("+JSONObject.quote(id)+","+response+")",null);});
    }
    private static byte[] readLimited(InputStream in) throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int n;
        while((n=in.read(buffer))!=-1){if(out.size()+n>LIMIT)throw new IOException("文件超过 15MB 限制");out.write(buffer,0,n);}return out.toByteArray();
    }
    public class Bridge {
        @JavascriptInterface public void setTheme(String theme){
            boolean dark="dark".equals(theme);
            runOnUiThread(()->{
                if(web==null)return;
                int color=android.graphics.Color.parseColor(dark?"#0e1117":"#f5f6fa");
                frame.setBackgroundColor(color);web.setBackgroundColor(color);
                getWindow().setStatusBarColor(color);getWindow().setNavigationBarColor(color);
                if(Build.VERSION.SDK_INT>=30){
                    WindowInsetsController controller=getWindow().getInsetsController();
                    int flags=WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    if(controller!=null)controller.setSystemBarsAppearance(dark?0:flags,flags);
                } else {
                    View decor=getWindow().getDecorView();
                    int light=View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    // Do not discard layout flags when toggling the theme.
                    decor.setSystemUiVisibility((decor.getSystemUiVisibility()&~light)|(dark?0:light));
                }
                frame.requestApplyInsets();
            });
        }
        @JavascriptInterface public String readLocal(){
            synchronized(storageLock){try {
                if(!local.getBaseFile().exists()&&!new File(local.getBaseFile()+".bak").exists())return ok(null).toString();
                try(InputStream in=local.openRead()){return ok(new JSONObject(new String(readLimited(in),StandardCharsets.UTF_8))).toString();}
            }catch(Exception e){return error("本地记录读取失败，已保留原文件。请勿卸载或清除应用数据。").toString();}}
        }
        @JavascriptInterface public String writeLocal(String text){
            synchronized(storageLock){FileOutputStream out=null;
                try {
                    byte[] bytes=text.getBytes(StandardCharsets.UTF_8);if(bytes.length>LIMIT)throw new IOException("本地数据超过 15MB，请导出备份");
                    JSONObject next=new JSONObject(text);if(next.getJSONObject("doc").getInt("format")!=1)throw new IOException("本地数据格式不正确");
                    if(local.getBaseFile().exists()){
                        byte[] previous;try(InputStream in=local.openRead()){previous=readLimited(in);}
                        JSONObject old=new JSONObject(new String(previous,StandardCharsets.UTF_8));
                        if(!old.getJSONObject("doc").toString().equals(next.getJSONObject("doc").toString())){
                            File directory=new File(getFilesDir(),"backups");directory.mkdirs();
                            File backup=new File(directory,"state-"+System.currentTimeMillis()+"-"+UUID.randomUUID()+".json");
                            try(FileOutputStream f=new FileOutputStream(backup)){f.write(previous);f.getFD().sync();}
                            File[] files=directory.listFiles();if(files!=null){Arrays.sort(files,Comparator.comparing(File::getName));for(int i=0;i<files.length-30;i++)files[i].delete();}
                        }
                    }
                    out=local.startWrite();out.write(bytes);local.finishWrite(out);out=null;return ok(true).toString();
                }catch(Exception e){if(out!=null)local.failWrite(out);return error("本地保存未完成："+e.getMessage()).toString();}
            }
        }
        @JavascriptInterface public void request(String id,String request){
            worker.execute(()->{try{
                JSONObject r=new JSONObject(request),args=r.getJSONObject("args");String action=r.getString("action");
                Object result;
                switch(action){
                    case "configGet":result=publicConfig(loadConfig());break;
                    case "configSave":result=saveConfig(args);break;
                    case "dav":result=dav(args);break;
                    case "export":startExport(id,args);return;
                    default:throw new IOException("不支持的操作");
                }
                reply(id,ok(result));
            }catch(Exception e){reply(id,error(e.getMessage()==null?"操作未完成，已保留本地数据":e.getMessage()));}});
        }
    }
    private SecretKey configKey() throws Exception {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias(KEY)){
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();
        }
        return (SecretKey)store.getKey(KEY,null);
    }
    private JSONObject loadConfig() throws Exception {
        String stored=getSharedPreferences("sync-secret",MODE_PRIVATE).getString("encrypted",null);
        if(stored==null)return new JSONObject().put("enabled",false).put("email","").put("password","").put("folder","personal-dashboard-v1");
        try{
            JSONObject p=new JSONObject(stored);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE,configKey(),new GCMParameterSpec(128,Base64.decode(p.getString("iv"),Base64.NO_WRAP)));
            byte[] value=cipher.doFinal(Base64.decode(p.getString("data"),Base64.NO_WRAP));
            return new JSONObject(new String(value,StandardCharsets.UTF_8));
        }catch(Exception e){throw new IOException("无法读取同步凭据；本地记录不受影响，请勿卸载应用");}
    }
    private JSONObject publicConfig(JSONObject c) throws JSONException {
        return new JSONObject().put("enabled",c.getBoolean("enabled")).put("email",c.getString("email")).put("folder",c.getString("folder")).put("hasPassword",!c.optString("password").isEmpty());
    }
    private JSONObject saveConfig(JSONObject args) throws Exception {
        JSONObject old=loadConfig();boolean enabled=args.optBoolean("enabled",false);
        String email=args.optString("email",old.getString("email")).trim(),folder=args.optString("folder",old.getString("folder")).trim();
        String password=args.optString("password");if(password.isEmpty())password=old.optString("password");
        if(args.optBoolean("forget")){password="";enabled=false;}
        if(!folder.matches("[a-zA-Z0-9_-]{1,64}"))throw new IOException("同步目录仅支持英文、数字、横线和下划线");
        if(enabled&&(!email.contains("@")||email.contains(":")||password.isEmpty()))throw new IOException("请填写坚果云邮箱和应用密码（不是登录密码）");
        if(enabled&&!email.equals(old.getString("email"))&&args.optString("password").isEmpty())throw new IOException("更换账号时请重新填写应用密码");
        JSONObject c=new JSONObject().put("enabled",enabled).put("email",email).put("folder",folder).put("password",password);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,configKey());
        byte[] encrypted=cipher.doFinal(c.toString().getBytes(StandardCharsets.UTF_8));
        JSONObject payload=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("data",Base64.encodeToString(encrypted,Base64.NO_WRAP));
        if(!getSharedPreferences("sync-secret",MODE_PRIVATE).edit().putString("encrypted",payload.toString()).commit())throw new IOException("保存凭据失败");
        return publicConfig(c);
    }
    private Object dav(JSONObject args) throws Exception {
        JSONObject c=loadConfig();if(!c.getBoolean("enabled"))throw new IOException("尚未开启坚果云同步");
        String op=args.getString("op"),name=args.optString("name"),method,body=null;
        if(!name.isEmpty()&&!name.matches("device-[a-f0-9]{32}\\.json"))throw new IOException("无效同步文件名");
        switch(op){
            case "mkdir":method="MKCOL";break;
            case "list":method="PROPFIND";body="<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>";break;
            case "get":method="GET";if(name.isEmpty())throw new IOException("缺少同步文件名");break;
            case "put":method="PUT";if(name.isEmpty())throw new IOException("缺少同步文件名");body=args.getString("body");JSONObject envelope=new JSONObject(body);if(!"personal-dashboard".equals(envelope.optString("app"))||envelope.optInt("protocol")!=1)throw new IOException("不是面板同步文件");break;
            default:throw new IOException("不支持的 WebDAV 操作");
        }
        if(body!=null&&body.getBytes(StandardCharsets.UTF_8).length>LIMIT)throw new IOException("同步文件超过 15MB");
        String folder=c.getString("folder");if(!folder.matches("[a-zA-Z0-9_-]{1,64}"))throw new IOException("同步目录不正确");
        Request.Builder builder=new Request.Builder().url(BASE+folder+"/"+name).header("Authorization",Credentials.basic(c.getString("email"),c.getString("password"),StandardCharsets.UTF_8)).header("Cache-Control","no-cache");
        if(op.equals("list"))builder.header("Depth","1");
        RequestBody rb=body==null?null:RequestBody.create(body,MediaType.parse(op.equals("list")?"application/xml; charset=utf-8":"application/json; charset=utf-8"));
        builder.method(method,rb);
        try(Response response=http.newCall(builder.build()).execute()){
            int status=response.code();
            if(op.equals("mkdir")&&status==405)return new JSONObject();
            if(!response.isSuccessful())throw new IOException(httpError(status));
            if(op.equals("mkdir"))return new JSONObject();
            if(op.equals("put"))return new JSONObject().put("etag",response.header("ETag",""));
            byte[] bytes=readLimited(response.body().byteStream());
            if(op.equals("get"))return new JSONObject().put("body",new String(bytes,StandardCharsets.UTF_8)).put("etag",response.header("ETag",""));
            if(status!=207)throw new IOException("未收到有效 WebDAV 目录列表");
            return parseListing(bytes,folder);
        }catch(java.net.SocketTimeoutException e){throw new IOException("连接超时，稍后自动重试；本地数据已保留");}
        catch(javax.net.ssl.SSLException e){throw new IOException("安全连接失败，未发送到不可信服务器");}
        catch(java.net.UnknownHostException e){throw new IOException("当前无法联网，稍后自动重试；本地数据已保留");}
    }
    private static String httpError(int status){
        switch(status){case 401:return "邮箱或应用密码不正确";case 403:return "坚果云拒绝访问，请检查授权或流量额度";case 404:return "同步目录或文件不存在";case 429:return "请求频率受限，稍后会自动重试";case 507:return "坚果云空间或流量额度不足";default:return "坚果云响应 HTTP "+status+"，本地数据已保留";}
    }
    private JSONArray parseListing(byte[] bytes,String folder) throws Exception {
        // No external entities or DTDs from remote XML.
        String xml=new String(bytes,StandardCharsets.UTF_8);
        if(xml.contains("<!DOCTYPE")||xml.contains("<!ENTITY"))throw new IOException("目录 XML 包含不允许的声明");
        DocumentBuilderFactory factory=DocumentBuilderFactory.newInstance();factory.setNamespaceAware(true);factory.setExpandEntityReferences(false);
        Document document=factory.newDocumentBuilder().parse(new ByteArrayInputStream(bytes));
        if(!"multistatus".equals(document.getDocumentElement().getLocalName())||!"DAV:".equals(document.getDocumentElement().getNamespaceURI()))throw new IOException("目录格式不正确");
        NodeList responses=document.getElementsByTagNameNS("DAV:","response");JSONArray list=new JSONArray();String prefix="/dav/"+folder+"/";
        for(int i=0;i<responses.getLength();i++){
            Element entry=(Element)responses.item(i);NodeList hrefs=entry.getElementsByTagNameNS("DAV:","href");if(hrefs.getLength()==0)continue;
            String path=Uri.parse(hrefs.item(0).getTextContent()).getPath();if(path==null||!path.startsWith(prefix))continue;
            String name=path.substring(prefix.length());if(!name.matches("device-[a-f0-9]{32}\\.json"))continue;
            String etag="";boolean success=false;NodeList props=entry.getElementsByTagNameNS("DAV:","propstat");
            for(int j=0;j<props.getLength();j++){
                Element prop=(Element)props.item(j);NodeList statuses=prop.getElementsByTagNameNS("DAV:","status");
                if(statuses.getLength()>0&&statuses.item(0).getTextContent().contains(" 200 ")){
                    success=true;NodeList tags=prop.getElementsByTagNameNS("DAV:","getetag");if(tags.getLength()>0)etag=tags.item(0).getTextContent();
                }
            }
            if(!success)throw new IOException("无法读取同步文件属性");
            list.put(new JSONObject().put("name",name).put("etag",etag));
        }
        return list;
    }
    private void startExport(String id,JSONObject args) throws Exception {
        String text=args.getString("text"),name=args.getString("name"),mime=args.optString("mime","application/json");
        if(text.getBytes(StandardCharsets.UTF_8).length>LIMIT)throw new IOException("导出内容过大");
        runOnUiThread(()->{
            if(exportID!=null){reply(id,error("请先完成上一次导出"));return;}
            exportID=id;exportText=text;
            Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE,name);
            try{startActivityForResult(i,EXPORT);}catch(Exception e){exportID=null;exportText=null;reply(id,error("无法打开系统文件保存窗口"));}
        });
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==IMPORT&&fileCallback!=null){fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result,data));fileCallback=null;}
        if(request==EXPORT&&exportID!=null){
            String id=exportID,text=exportText;exportID=null;exportText=null;
            if(result!=RESULT_OK||data==null||data.getData()==null){reply(id,error("已取消导出"));return;}
            Uri uri=data.getData();worker.execute(()->{try(OutputStream out=getContentResolver().openOutputStream(uri,"wt")){
                if(out==null)throw new IOException("无法写入所选文件");out.write(text.getBytes(StandardCharsets.UTF_8));out.flush();reply(id,ok(true));
            }catch(Exception e){reply(id,error("导出失败，本地记录仍保留"));}});
        }
    }
}
