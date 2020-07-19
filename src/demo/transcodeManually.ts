import beamcoder, {DecodedFrames, Encoder, Filterer, FiltererAudioOptions, Muxer, Packet, Stream} from "beamcoder";
import * as process from "process";

async function writeFrames(encodedFrames: { packets: Packet[] }, targetStream: Stream, muxer: Muxer) {
    for (let encodedPackets of encodedFrames.packets) {
        encodedPackets.stream_index = targetStream.index;
        console.log(encodedPackets.stream_index, encodedPackets.pts);
        await muxer.writeFrame(encodedPackets);
    }
}

async function createAudioFormatFilter(audioEncoder: Encoder, inputAudioStream: Stream) : Promise<Filterer> {
    let filterOptions = {
        filterType: 'audio',
        filterSpec: `aresample=${audioEncoder.sample_rate}, aformat=sample_fmts=${audioEncoder.sample_fmt}:channel_layouts=${audioEncoder.channel_layout}`,
        inputParams: [{
            timeBase: inputAudioStream.time_base,
            sampleFormat: inputAudioStream.codecpar.format,
            sampleRate: inputAudioStream.codecpar.sample_rate,
            channelLayout: inputAudioStream.codecpar.channel_layout
        }],
        outputParams: [{
            sampleFormat: audioEncoder.sample_fmt,
            sampleRate: audioEncoder.sample_rate,
            channelLayout: audioEncoder.channel_layout
        }]
    } as FiltererAudioOptions;
    const audioReformatter = await beamcoder.filterer(filterOptions);
    console.debug(audioReformatter.graph.dump());
    return audioReformatter;
}

async function recodeAndWrite(audioFilter: Filterer, decodedFrames: DecodedFrames, audioEncoder: Encoder, outputAudioStream: Stream, muxer: Muxer) {
    let reformattedFrames = await audioFilter.filter(decodedFrames.frames);
    for (let rff of reformattedFrames) {
        let encodedFrames = await audioEncoder.encode(rff.frames);
        await writeFrames(encodedFrames, outputAudioStream, muxer);
    }
}

async function go(input: string, output: string) {
    const mp4Format = beamcoder.muxers().mp4;
    const audioCodec = beamcoder.encoders()[mp4Format.audio_codec];

    const demuxer = await beamcoder.demuxer(input);
    const inputAudioStream = demuxer.streams[2];
    const inputVideoStream = demuxer.streams[0];
    const audioDecoder = beamcoder.decoder({
        demuxer: demuxer,
        stream_index: inputAudioStream.index
    });

    const muxer = await beamcoder.muxer({
        filename: 'file:' + output,
        format_name: mp4Format.name
    });

    const audioEncoder = beamcoder.encoder({
        codec_id: audioCodec.id,
        sample_rate: inputAudioStream.codecpar.sample_rate,
        sample_fmt: audioCodec.sample_fmts[0],
        channels: inputAudioStream.codecpar.channels,
        channel_layout: inputAudioStream.codecpar.channel_layout,
        time_base: [1, inputAudioStream.codecpar.sample_rate],
        bit_rate: 127832,
        profile: 1 // aac_low
    });

    const audioReformatter = await createAudioFormatFilter(audioEncoder, inputAudioStream);

    const outputVideoStream = muxer.newStream(inputVideoStream);
    const outputAudioStream = muxer.newStream({
        codecpar: {
            name: audioEncoder.name,
            channels: audioEncoder.channels,
            sample_rate: audioEncoder.sample_rate,
            format: audioEncoder.sample_fmt,
            channel_layout: audioEncoder.channel_layout,
            bit_rate: audioEncoder.bit_rate,
            frame_size: audioEncoder.frame_size,
            profile: audioEncoder.profile
        },
        channel_layout: audioEncoder.channel_layout,
        channels: audioEncoder.channels,
        time_base: audioEncoder.time_base,
        name: audioEncoder.name
    });

    await muxer.openIO();
    await muxer.writeHeader({
        // movflags: 'empty_moov+frag_keyframe+faststart'
    });

    let packet: Packet;
    while (packet = await demuxer.read()) {
        if (packet.stream_index === inputVideoStream.index) {
            await writeFrames({packets: [packet]}, outputVideoStream, muxer);
        } else if (packet.stream_index === inputAudioStream.index) {
            let decodedFrames = await audioDecoder.decode(packet);
            await recodeAndWrite(audioReformatter, decodedFrames, audioEncoder, outputAudioStream, muxer);
        }
    }

    recodeAndWrite(audioReformatter, await audioDecoder.flush(), audioEncoder, outputAudioStream, muxer);

    await writeFrames(await audioEncoder.flush(), outputAudioStream, muxer);

    await muxer.writeTrailer();
}

go("file:" + process.argv[2], process.argv[3]);
