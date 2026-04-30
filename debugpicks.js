const mongoose = require("mongoose");
mongoose.connect("mongodb+srv://roizemanuel_db_user:stp4IcKMxauY8yJ5@cluster0.xmqffom.mongodb.net/thepickzone").then(async()=>{
  const Pick = mongoose.model("Pick", new mongoose.Schema({},{strict:false}));
  const picks = await Pick.find({ result: "pending" }, { match:1, time:1, ticketImg:1 });
  picks.forEach(p => {
    const mo = {Ene:0,Feb:1,Mar:2,Abr:3,May:4,Jun:5,Jul:6,Ago:7,Sep:8,Oct:9,Nov:10,Dic:11};
    const pat = p.time?.match(/(\d{1,2})\s+(\w+)\s+-\s+(\d{2}):(\d{2})/);
    if(pat){
      const now = new Date();
      const month = mo[pat[2]];
      const matchTime = new Date(now.getFullYear(), month, parseInt(pat[1]), parseInt(pat[3]), parseInt(pat[4]));
      const endTime = new Date(matchTime.getTime() + 3*60*60*1000);
      console.log(p.match, "| time:", p.time, "| matchTime:", matchTime, "| ended:", now > endTime, "| hasImg:", !!p.ticketImg);
    } else {
      console.log(p.match, "| time:", p.time, "| NO PARSE");
    }
  });
  mongoose.disconnect();
}).catch(e=>console.log(e.message));
