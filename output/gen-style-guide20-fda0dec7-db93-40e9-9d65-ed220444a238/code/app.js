(function(){
'use strict';
var W=320,H=480;

/* === 1. AMBIENT PARTICLE FIELD === */
var cv=document.getElementById('particles'),cx=cv.getContext('2d');
cv.width=W;cv.height=H;
var NP=22,pool=[];
function mp(ry){
  return{x:Math.random()*W,y:ry?Math.random()*H:H+5,r:Math.random()*1.4+.4,vy:-(Math.random()*.35+.12),vx:(Math.random()-.5)*.18,a:Math.random()*.35+.08,d:Math.random()*.0004+.00015};
}
for(var i=0;i<NP;i++)pool.push(mp(true));
function dp(){
  cx.clearRect(0,0,W,H);
  for(var j=0;j<pool.length;j++){
    var p=pool[j];p.x+=p.vx;p.y+=p.vy;p.a-=p.d;
    if(p.y<-5||p.a<=0){pool[j]=mp(false);continue;}
    cx.beginPath();cx.arc(p.x,p.y,p.r,0,6.2832);
    cx.fillStyle='rgba(233,27,33,'+p.a.toFixed(3)+')';cx.fill();
  }
  requestAnimationFrame(dp);
}
dp();

/* === 2. INTRO SEQUENCE === */
var intro=document.getElementById('intro');
var content=document.getElementById('content');
var eline=document.getElementById('energy-line');
var revs=document.querySelectorAll('.reveal');
setTimeout(function(){
  intro.classList.add('hidden');
  content.classList.add('visible');
  eline.classList.add('active');
  for(var k=0;k<revs.length;k++){
    (function(el,dl){setTimeout(function(){el.classList.add('show');},dl);})(revs[k],k*120);
  }
  setTimeout(runCounters,revs.length*120+250);
},2400);

/* === 3. GALLERY SWIPE === */
var track=document.getElementById('gallery-track');
var gal=document.getElementById('gallery');
var dots=document.querySelectorAll('.dot');
var SC=3,cur=0,sx=0,dx=0,drag=false;
function goTo(n){
  cur=Math.max(0,Math.min(n,SC-1));
  track.style.transform='translateX('+(-cur*W)+'px)';
  for(var d=0;d<dots.length;d++)dots[d].classList.toggle('active',d===cur);
}
function endDrag(){
  if(!drag)return;drag=false;
  track.style.transition='transform .45s cubic-bezier(.22,.68,.35,1)';
  if(dx<-35)goTo(cur+1);else if(dx>35)goTo(cur-1);else goTo(cur);
  dx=0;
}
gal.addEventListener('touchstart',function(e){sx=e.touches[0].clientX;drag=true;track.style.transition='none';clearInterval(at);},{passive:true});
gal.addEventListener('touchmove',function(e){if(!drag)return;dx=e.touches[0].clientX-sx;track.style.transform='translateX('+(-cur*W+dx)+'px)';},{passive:true});
gal.addEventListener('touchend',endDrag);
gal.addEventListener('mousedown',function(e){sx=e.clientX;drag=true;track.style.transition='none';clearInterval(at);e.preventDefault();});
gal.addEventListener('mousemove',function(e){if(!drag)return;dx=e.clientX-sx;track.style.transform='translateX('+(-cur*W+dx)+'px)';});
gal.addEventListener('mouseup',endDrag);
gal.addEventListener('mouseleave',function(){if(drag)endDrag();});
for(var di=0;di<dots.length;di++){
  (function(idx){dots[idx].addEventListener('click',function(){goTo(idx);});})(di);
}
var at=setInterval(function(){goTo((cur+1)%SC);},4000);

/* === 4. COUNTER ANIMATION === */
function runCounters(){
  var specs=document.querySelectorAll('.spec');
  for(var s=0;s<specs.length;s++){
    (function(sp){
      var tgt=parseInt(sp.getAttribute('data-target'),10);
      var suf=sp.getAttribute('data-suffix')||'';
      var pre=sp.getAttribute('data-prefix')||'';
      var el=sp.querySelector('.spec-val');
      var dur=1400,t0=performance.now();
      function step(now){
        var pr=Math.min((now-t0)/dur,1);
        var ea=1-Math.pow(1-pr,3);
        el.textContent=pre+Math.round(ea*tgt)+suf;
        if(pr<1)requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    })(specs[s]);
  }
}

/* === 5. RIPPLE FEEDBACK === */
var ad=document.getElementById('ad');
var rl=document.getElementById('ripple-layer');
ad.addEventListener('click',function(e){
  var r=ad.getBoundingClientRect();
  var c=document.createElement('div');
  c.className='ripple-circle';
  c.style.left=(e.clientX-r.left)+'px';
  c.style.top=(e.clientY-r.top)+'px';
  rl.appendChild(c);
  setTimeout(function(){c.remove();},750);
});

/* === 6. CTA SHIMMER === */
var cta=document.getElementById('cta-btn');
var ss=document.createElement('style');
ss.textContent='@keyframes shimmerMove{0%{left:-50%}100%{left:120%}}';
document.head.appendChild(ss);
cta.addEventListener('mouseenter',function(){
  var sh=document.createElement('span');
  sh.style.cssText='position:absolute;top:0;left:-100%;width:50%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),transparent);animation:shimmerMove .6s ease-out forwards;pointer-events:none;';
  cta.appendChild(sh);
  setTimeout(function(){sh.remove();},650);
});

})();