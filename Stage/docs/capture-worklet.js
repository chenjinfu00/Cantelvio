class Capture extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(2205);this.offset=0;}
  process(inputs){
    const source=inputs[0]?.[0];if(!source)return true;
    for(let i=0;i<source.length;i++){
      this.buffer[this.offset++]=source[i];
      if(this.offset===this.buffer.length){this.port.postMessage(this.buffer,[this.buffer.buffer]);this.buffer=new Float32Array(2205);this.offset=0;}
    }
    return true;
  }
}
registerProcessor('volta-capture',Capture);
